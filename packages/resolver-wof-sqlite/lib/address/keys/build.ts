/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds one region's address layer, `lookup.db` and `detail.db`, from a stream of address records.
 *
 *   Records are staged once into a scratch database with one row per key they answer. Each key table is then
 *   written in key order with `INSERT … SELECT … ORDER BY`, so its B-tree pages hold contiguous keys.
 */

import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { sourcePresentCoverageCells } from "@mailwoman/core/layers"
import { type LayerManifest, writeLayerCoverage, writeLayerManifest } from "@mailwoman/core/layers/manifest"
import { createLayerCoverageTable, createLayerManifestTable } from "@mailwoman/core/layers/schema"
import { shortCellToInt } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { buildSealedArtifact } from "@mailwoman/sqlite/sealed/build"
import { latLngToCell } from "@sister.software/h3"
import { type Kysely, sql } from "kysely"
import type { PathBuilderLike } from "path-ts"

import { addressPostcodeKey } from "#address/keys/postcode"
import {
	ADDRESS_SCOPED_KEY_TABLES,
	ADDRESS_STREET_TABLES,
	type AddressDetailDatabase,
	type AddressLookupDatabase,
	createAddressDetailTable,
	createAddressPlaceKeyTable,
	createAddressRegionKeyTable,
	createAddressScopedKeyTable,
	createAddressSourceTable,
	createAddressStreetTable,
} from "#address/keys/schema"
import type { AddressRecord } from "#address/record"

/**
 * The SQLite page size of both files.
 *
 * At 8 KiB a key hit read 4 pages in 3 range chunks on the Wisconsin prototype.
 */
export const ADDRESS_LAYER_PAGE_SIZE = 8192

/**
 * The H3 resolution `layer_coverage` counts points at, about 36 km² per cell.
 */
export const ADDRESS_LAYER_COVERAGE_RESOLUTION = 6

/**
 * The provenance a caller states for the layer it builds.
 *
 * The build supplies the schema version, the spine keys and the per-source record counts.
 */
export type AddressLayerManifest = Omit<LayerManifest, "schemaVersion" | "spineKeys" | "sourceRecords">

/**
 * The level each staged key row answers.
 * Each level is written to the key table of the same name.
 */
const StagedLevel = {
	Postcode: "key_postcode",
	Locality: "key_locality",
	Subregion: "key_subregion",
	Region: "key_region",
} as const

type StagedLevel = (typeof StagedLevel)[keyof typeof StagedLevel]

/**
 * The scratch schema: every key row an address answers, and every address's detail row.
 */
interface StagingDatabase extends AddressDetailDatabase {
	stage: {
		level: StagedLevel
		scope: string
		street: string
		number: string
		address_id: number
		lat: number
		lon: number
		source_id: number
	}
	source_ids: {
		name: string
		source_id: number
	}
}

/**
 * One keyed read a build must answer: a street and number under one level's scope.
 *
 * `scope` is ignored for `key_region`, which has none.
 */
export interface AddressLayerReadCheck {
	table: StagedLevel
	scope: string
	street: string
	number: string
}

/**
 * What a source's rows are published under, from the register.
 */
export interface AddressSourceTerms {
	license: string | null
	authority: string | null
}

export interface BuildAddressLayerOptions {
	records: AsyncIterable<AddressRecord>
	/**
	 * The terms of each source id the records hold.
	 * A record whose source has no entry stops the build.
	 */
	sources: ReadonlyMap<string, AddressSourceTerms>
	/**
	 * The `layer_manifest` row `lookup.db` holds.
	 */
	manifest: AddressLayerManifest
	/**
	 * Keyed reads the finished `lookup.db` must answer before it is sealed,
	 * such as a known address at each level.
	 */
	checks?: readonly AddressLayerReadCheck[]
	lookupPath: PathBuilderLike
	detailPath: PathBuilderLike
	/**
	 * Called after every millionth record with the count staged so far.
	 */
	onProgress?: (records: number) => void
}

/**
 * The counts one build wrote.
 * Its checks compare them against the tables.
 */
export interface AddressLayerBuildSummary {
	records: number
	/**
	 * Key rows written per key table.
	 */
	keys: Record<StagedLevel, number>
	/**
	 * Records per source id.
	 */
	sources: Record<string, number>
	/**
	 * Locality names per record, the duplication the per-form keys cost.
	 */
	localityFormsPerRecord: number
	/**
	 * Points per H3 cell at {@link ADDRESS_LAYER_COVERAGE_RESOLUTION}, keyed by the cell's short integer form.
	 */
	coverage: ReadonlyMap<number, number>
}

async function createStagingTables(db: Kysely<StagingDatabase>): Promise<void> {
	await db.schema
		.createTable("stage")
		.addColumn("level", "text", (c) => c.notNull())
		.addColumn("scope", "text", (c) => c.notNull())
		.addColumn("street", "text", (c) => c.notNull())
		.addColumn("number", "text", (c) => c.notNull())
		.addColumn("address_id", "integer", (c) => c.notNull())
		.addColumn("lat", "real", (c) => c.notNull())
		.addColumn("lon", "real", (c) => c.notNull())
		.addColumn("source_id", "integer", (c) => c.notNull())
		.execute()

	await db.schema
		.createTable("source_ids")
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("source_id", "integer", (c) => c.notNull())
		.execute()

	await createAddressDetailTable(db)
}

/**
 * Stages every record, then writes `lookup.db` and `detail.db` beside their targets
 * and swaps each into place.
 *
 * @throws When a record's source has no entry in `sources`, or when a key table's
 * row count differs from the rows staged for its level.
 */
export async function buildAddressLayer(options: BuildAddressLayerOptions): Promise<AddressLayerBuildSummary> {
	const stagingPath = `${options.lookupPath}.stage-${process.pid}`

	await removePathIfPresent(stagingPath)

	try {
		const summary = await stageRecords(options, stagingPath)

		await writeLookup(options.lookupPath, stagingPath, summary, options.sources, options.manifest, options.checks ?? [])
		await writeDetail(options.detailPath, stagingPath, summary)

		return summary
	} finally {
		await removePathIfPresent(stagingPath)
	}
}

async function stageRecords(options: BuildAddressLayerOptions, stagingPath: string): Promise<AddressLayerBuildSummary> {
	using db = new DatabaseClient<StagingDatabase>(stagingPath)

	db.exec(
		`PRAGMA page_size = ${ADDRESS_LAYER_PAGE_SIZE}; PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -400000;`
	)

	await createStagingTables(db)

	const stage = db.prepare("INSERT INTO stage VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
	const detail = db.prepare("INSERT INTO address VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
	const sourceIDs = new Map<string, number>()
	const keys: Record<StagedLevel, number> = { key_postcode: 0, key_locality: 0, key_subregion: 0, key_region: 0 }
	const sources: Record<string, number> = {}
	const coverage = new Map<number, number>()
	let records = 0
	let localityNames = 0

	db.exec("BEGIN")

	for await (const record of options.records) {
		if (!options.sources.has(record.source)) {
			throw new Error(
				`address record ${record.sourceRecordID} has source ${record.source}, which the build lists no terms for`
			)
		}

		let sourceID = sourceIDs.get(record.source)

		if (sourceID == null) {
			sourceID = sourceIDs.size + 1
			sourceIDs.set(record.source, sourceID)
		}

		const addressID = ++records

		sources[record.source] = (sources[record.source] ?? 0) + 1

		const put = (level: StagedLevel, scope: string) => {
			stage.run(level, scope, record.streetKey, record.number, addressID, record.lat, record.lon, sourceID)

			keys[level]++
		}

		const postcode = addressPostcodeKey(record.country, record.postcode)

		if (postcode) {
			put(StagedLevel.Postcode, postcode)
		}

		for (const name of record.names) {
			if (name.level === "locality" || name.level === "dependent_locality") {
				put(StagedLevel.Locality, name.key)

				localityNames++
			} else if (name.level === "subregion") {
				put(StagedLevel.Subregion, name.key)
			}
		}

		put(StagedLevel.Region, "")

		const cell = shortCellToInt(latLngToCell(record.lat, record.lon, ADDRESS_LAYER_COVERAGE_RESOLUTION))

		coverage.set(cell, (coverage.get(cell) ?? 0) + 1)

		detail.run(
			addressID,
			sourceID,
			record.sourceRecordID,
			record.country,
			record.number,
			record.unit,
			record.streetRaw,
			record.postcode,
			stringifyJSON(record.names.map(({ level, form, value }) => ({ level, form, value }))),
			record.adminCode,
			record.lat,
			record.lon,
			record.placement,
			record.authority
		)

		if (records % 200_000 === 0) {
			db.exec("COMMIT; BEGIN")
		}

		if (records % 1_000_000 === 0) {
			options.onProgress?.(records)
		}
	}

	db.exec("COMMIT")

	const sourceRow = db.prepare("INSERT INTO source_ids VALUES (?, ?)")

	for (const [name, id] of sourceIDs) {
		sourceRow.run(name, id)
	}

	return {
		records,
		keys,
		sources,
		localityFormsPerRecord: records ? localityNames / records : 0,
		coverage,
	}
}

async function writeLookup(
	lookupPath: PathBuilderLike,
	stagingPath: string,
	summary: AddressLayerBuildSummary,
	terms: ReadonlyMap<string, AddressSourceTerms>,
	manifest: AddressLayerManifest,
	checks: readonly AddressLayerReadCheck[]
): Promise<void> {
	await buildSealedArtifact<AddressLookupDatabase, true, void>({
		out: lookupPath,
		createTables: async (db) => {
			db.exec(`PRAGMA page_size = ${ADDRESS_LAYER_PAGE_SIZE}`)
			await createLayerManifestTable(db)
			await createLayerCoverageTable(db)
			await createAddressSourceTable(db)

			for (const table of ADDRESS_SCOPED_KEY_TABLES) {
				await createAddressScopedKeyTable(db, table)
			}

			await createAddressPlaceKeyTable(db)
			await createAddressRegionKeyTable(db)

			for (const table of ADDRESS_STREET_TABLES) {
				await createAddressStreetTable(db, table)
			}
		},
		ingest: async (db) => {
			db.exec(`ATTACH DATABASE '${stagingPath.replaceAll("'", "''")}' AS staged`)

			const insertSource = db.prepare("INSERT INTO source VALUES (?, ?, ?, ?, ?)")

			const ids = db.prepare("SELECT name, source_id FROM staged.source_ids ORDER BY source_id").all() as Array<{
				name: string
				source_id: number
			}>

			for (const { name, source_id } of ids) {
				const term = terms.get(name)!

				insertSource.run(source_id, name, term.license, term.authority, summary.sources[name] ?? 0)
			}

			// A record's locality and dependent-locality names can share a key,
			// so a key row repeated for one address is written once.
			for (const table of ADDRESS_SCOPED_KEY_TABLES) {
				db.exec(
					`INSERT OR IGNORE INTO ${table} SELECT scope, street, number, address_id, lat, lon, source_id
					 FROM staged.stage WHERE level = '${table}' ORDER BY scope, street, number, address_id`
				)
			}

			db.exec(
				`INSERT OR IGNORE INTO key_region SELECT street, number, address_id, lat, lon, source_id
				 FROM staged.stage WHERE level = 'key_region' ORDER BY street, number, address_id`
			)

			for (const [table, level] of [
				["street_postcode", "key_postcode"],
				["street_locality", "key_locality"],
			] as const) {
				db.exec(
					`INSERT INTO ${table} SELECT scope, street, avg(lat), avg(lon), min(lat), max(lat), min(lon), max(lon), count(*)
					 FROM staged.stage WHERE level = '${level}' GROUP BY scope, street ORDER BY scope, street`
				)
			}

			db.exec("DETACH DATABASE staged")

			return true
		},
		finish: async (db) => {
			for (const table of [...ADDRESS_SCOPED_KEY_TABLES, "key_region"] as const) {
				const { count } = (await db
					.selectFrom(table)
					.select(sql<number>`count(*)`.as("count"))
					.executeTakeFirstOrThrow()) as { count: number }

				if (count > summary.keys[table]) {
					throw new Error(`${table} holds ${count} rows, more than the ${summary.keys[table]} staged for it`)
				}
			}

			const unanswered = checks.filter((check) => {
				const row =
					check.table === StagedLevel.Region
						? db
								.prepare("SELECT 1 FROM key_region WHERE street = ? AND number = ? LIMIT 1")
								.get(check.street, check.number)
						: db
								.prepare(`SELECT 1 FROM ${check.table} WHERE scope = ? AND street = ? AND number = ? LIMIT 1`)
								.get(check.scope, check.street, check.number)

				return row == null
			})

			if (unanswered.length) {
				const listed = unanswered.map((check) => `${check.table} ${check.scope} ${check.street} ${check.number}`)

				throw new Error(`lookup.db misses ${unanswered.length} of ${checks.length} checked reads: ${listed.join("; ")}`)
			}

			await writeLayerCoverage(db, sourcePresentCoverageCells(summary.coverage))

			await writeLayerManifest(db, {
				...manifest,
				schemaVersion: 1,
				spineKeys: { h3: { column: "layer_coverage.h3_cell", resolution: ADDRESS_LAYER_COVERAGE_RESOLUTION } },
				sourceRecords: summary.sources,
			})
		},
	})
}

async function writeDetail(detailPath: PathBuilderLike, stagingPath: string, summary: AddressLayerBuildSummary) {
	await buildSealedArtifact<AddressDetailDatabase, true, void>({
		out: detailPath,
		createTables: async (db) => {
			db.exec(`PRAGMA page_size = ${ADDRESS_LAYER_PAGE_SIZE}`)
			await createAddressDetailTable(db)
		},
		ingest: async (db) => {
			db.exec(`ATTACH DATABASE '${stagingPath.replaceAll("'", "''")}' AS staged`)
			db.exec("INSERT INTO address SELECT * FROM staged.address ORDER BY address_id")
			db.exec("DETACH DATABASE staged")

			return true
		},
		finish: async (db) => {
			const { count } = (await db
				.selectFrom("address")
				.select(sql<number>`count(*)`.as("count"))
				.executeTakeFirstOrThrow()) as { count: number }

			if (count !== summary.records) {
				throw new Error(`address holds ${count} rows, against ${summary.records} records staged`)
			}
		},
	})
}
