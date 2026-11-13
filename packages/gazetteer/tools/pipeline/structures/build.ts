// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds the country-general structures layer, `structures.db`,
 *   from every registered official list of public structures: post-office lists,
 *   and compilations such as the USGS National Structures Dataset's schools, hospitals,
 *   emergency stations, government buildings and recreation sites.
 *
 *   The layer is a POI database the geocoder searches beside `poi.db`.
 *   Every row is in the POI taxonomy category its record names, stamped with its
 *   source's country, and keyed `<source id>:<record id>` in `gers_id`.
 *
 *   The `structure_source` table holds each source's publisher, terms,
 *   provenance class, vintage and record counts.
 *
 *   The manifest states one license: the conjunction of the contributing sources' licenses,
 *   as the admin gazetteer's manifest does for its folds.
 *   `sourceRecords` holds each source's input count.
 *
 *   The layer is `shipped` unless a contributing license has a share-alike obligation.
 */

import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { LayerTier } from "@mailwoman/core/layers"
import { carriesShareAlike, readLicenseRecord } from "@mailwoman/core/license/record"
import type { StructureSource } from "@mailwoman/corpus/structures/source"
import type { POISourceRow } from "@mailwoman/osm/sdk/extract/poi"
import { getPOICategory } from "@mailwoman/poi-taxonomy/lookup"
import type { POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed/db"
import { type PathBuilder, type PathBuilderLike, resolvePath } from "path-ts"

import { buildPOIDatabase, type BuildPOIResult, type POILayerTerms } from "#tools/pipeline/poi/build/poi"
import { createStructureSourceTable, type StructureSourceDatabase } from "#tools/pipeline/structures/schema"

/**
 * The manifest name of the structures layer.
 */
export const STRUCTURE_LAYER_NAME = "structures"

/**
 * The row counts one source contributed.
 */
export interface StructureSourceCounts {
	inputRecords: number
	recordsWithoutPoint: number
	/**
	 * Rows written, keyed by POI category id.
	 */
	categories: Record<string, number>
}

/**
 * The manifest terms for a layer folded from `sources`.
 *
 * `sourceRecords` is the object the build fills as it reads, so it is complete once the rows are consumed.
 */
export function structureLayerTerms(
	sources: readonly StructureSource[],
	sourceRecords: Record<string, number>
): POILayerTerms {
	const license = [...new Set(sources.map((source) => source.license))].join(" AND ")
	const shareAlike = sources.some((source) => carriesShareAlike(readLicenseRecord(source.license)))

	return {
		name: STRUCTURE_LAYER_NAME,
		source: sources.map((source) => source.id).join("+"),
		license,
		attribution: sources.map((source) => source.attribution).join("; "),
		tier: shareAlike ? LayerTier.BuildLocal : LayerTier.Shipped,
		buildCmd: "mailwoman gazetteer build structures",
		sourceRecords,
	}
}

/**
 * Options for {@link buildStructureLayer}.
 */
export interface BuildStructureLayerOptions {
	sources: readonly StructureSource[]
	/**
	 * The root `mailwoman corpus fetch` wrote each source's input under.
	 */
	sourcesRoot: PathBuilder
	out: PathBuilderLike
	buildSHA: string
	/**
	 * @defaultValue the current time.
	 */
	createdAt?: string
	onProgress?: (phase: string, message: string) => void
}

/**
 * What a structures layer build wrote.
 */
export interface BuildStructureLayerResult extends BuildPOIResult {
	/**
	 * Each source's counts, keyed by source id.
	 */
	sources: Map<string, StructureSourceCounts & { vintage: string }>
}

/**
 * Builds and seals `structures.db` from every source, replacing any existing file at `out`.
 *
 * @throws When no source is given, when a source's input cannot be read, or
 * when a record's category is one the POI taxonomy doesn't hold.
 */
export async function buildStructureLayer(opts: BuildStructureLayerOptions): Promise<BuildStructureLayerResult> {
	if (!opts.sources.length) {
		throw new Error("buildStructureLayer: no structure source is registered, so the layer would be empty")
	}

	const reads = await Promise.all(
		opts.sources.map(async (source) => ({ source, read: await source.read(opts.sourcesRoot) }))
	)

	const counts = new Map<string, StructureSourceCounts & { vintage: string }>()
	const sourceRecords: Record<string, number> = {}

	for (const { source, read } of reads) {
		counts.set(source.id, { inputRecords: 0, recordsWithoutPoint: 0, categories: {}, vintage: read.vintage })
	}

	async function* rows(): AsyncIterable<POISourceRow> {
		for (const { source, read } of reads) {
			const sourceCounts = counts.get(source.id)!

			for await (const record of read.records) {
				sourceCounts.inputRecords++

				if (!getPOICategory(record.category)) {
					throw new Error(
						`${source.id}:${record.id} names the category "${record.category}", which the POI taxonomy doesn't hold`
					)
				}

				if (!record.point) {
					sourceCounts.recordsWithoutPoint++

					continue
				}

				sourceCounts.categories[record.category] = (sourceCounts.categories[record.category] ?? 0) + 1

				yield {
					name: record.name,
					category: record.category,
					brandWikidata: null,
					latitude: record.point.latitude,
					longitude: record.point.longitude,
					country: source.country,
					confidence: 1,
					gersID: `${source.id}:${record.id}`,
				}
			}

			sourceRecords[source.id] = sourceCounts.inputRecords
		}
	}

	// Built beside its destination and swapped in once sealed, so a failed build leaves the previous layer in place.
	const out = resolvePath(opts.out)
	const staging = `${out}.building-${process.pid}`

	try {
		const result = await buildLayer(staging)

		await swapDatabaseIntoPlace(staging, out)

		return { ...result, out, sources: counts }
	} finally {
		await removePathIfPresent(staging)
	}

	function buildLayer(path: string): Promise<BuildPOIResult> {
		return buildPOIDatabase({
			rows: rows(),
			out: path,
			release: reads.map(({ source, read }) => `${source.id}=${read.vintage}`).join(" "),
			buildSHA: opts.buildSHA,
			createdAt: opts.createdAt,
			terms: structureLayerTerms(opts.sources, sourceRecords),
			onProgress: opts.onProgress,
			writeTables: async (kdb: DatabaseClient<POIDatabase>) => {
				const db = kdb.withTables<StructureSourceDatabase>()

				await createStructureSourceTable(db)

				await db
					.insertInto("structure_source")
					.values(
						opts.sources.map((source) => {
							const sourceCounts = counts.get(source.id)!

							return {
								source_id: source.id,
								country: source.country,
								publisher: source.publisher,
								provenance: source.provenance,
								license: source.license,
								attribution: source.attribution,
								register_source: source.registerSource,
								vintage: sourceCounts.vintage,
								input_records: sourceCounts.inputRecords,
								records_without_point: sourceCounts.recordsWithoutPoint,
							}
						})
					)
					.execute()
			},
		})
	}
}
