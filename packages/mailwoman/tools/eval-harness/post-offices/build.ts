// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds the post-office parse suite from the post offices of every registered
 *   structure source (`@mailwoman/corpus/structures/sources`), the records filed under
 *   the POI taxonomy's post-office category, and freezes it as a held-out dataset
 *   (`heldout/dataset/manifest.ts`), the shape the OpenStreetMap suites are frozen in.
 *
 *   The suite holds every row its sources yield rather than a sample, under the `every-row` sampling
 *   method, because its contract is that the parser handles every official post-office address.
 *   A lineage file beside it records each source's terms, provenance class, vintage and tally.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { canonicalJSON } from "@mailwoman/core/json"
import { postOfficeCategoryID, type StructureSource } from "@mailwoman/corpus/structures/source"
import { type PathBuilder, resolvePath } from "path-ts"

import { type HeldoutDatasetManifest, writeHeldoutDataset } from "#tools/eval-harness/heldout/dataset/manifest"
import { countHeldoutCells } from "#tools/eval-harness/heldout/per/country"
import {
	postOfficeSuiteRows,
	type PostOfficeSuiteRow,
	type PostOfficeSuiteTally,
} from "#tools/eval-harness/post-offices/rows"

/**
 * The suite's dataset id, and the base name of its manifest, rows and lineage files.
 */
export const POST_OFFICE_SUITE_ID = "post-office-suite"

/**
 * What one source contributed to the suite.
 */
export interface PostOfficeSuiteSourceLineage {
	id: string
	country: string
	publisher: string
	license: string
	registerSource: string
	provenance: string
	vintage: string
	tally: PostOfficeSuiteTally
}

/**
 * A built suite.
 */
export interface BuiltPostOfficeSuite {
	manifestPath: string
	lineagePath: string
	manifest: HeldoutDatasetManifest
	rows: PostOfficeSuiteRow[]
	sources: PostOfficeSuiteSourceLineage[]
}

/**
 * Reads every source's post offices into suite rows, in source order.
 *
 * A record filed under another category is no post office and yields no row.
 */
export async function collectPostOfficeSuiteRows(
	sources: readonly StructureSource[],
	sourcesRoot: PathBuilder
): Promise<{ rows: PostOfficeSuiteRow[]; sources: PostOfficeSuiteSourceLineage[] }> {
	const rows: PostOfficeSuiteRow[] = []
	const lineage: PostOfficeSuiteSourceLineage[] = []
	const postOffice = postOfficeCategoryID()

	for (const source of sources) {
		const read = await source.read(sourcesRoot)
		const tally: PostOfficeSuiteTally = {}

		for await (const record of read.records) {
			if (record.category !== postOffice) continue

			rows.push(...postOfficeSuiteRows(source, record, tally))
		}

		lineage.push({
			id: source.id,
			country: source.country,
			publisher: source.publisher,
			license: source.license,
			registerSource: source.registerSource,
			provenance: source.provenance,
			vintage: read.vintage,
			tally,
		})
	}

	return { rows, sources: lineage }
}

/**
 * Builds the suite from `sources` and writes its manifest, rows and lineage under `outDirectory`.
 *
 * @throws When no source is given, or when a source's input cannot be read.
 */
export async function buildPostOfficeSuite(input: {
	sources: readonly StructureSource[]
	sourcesRoot: PathBuilder
	outDirectory: string
	createdAt: string
}): Promise<BuiltPostOfficeSuite> {
	if (!input.sources.length) throw new Error("no post-office source is registered, so the suite would be empty")

	const { rows, sources } = await collectPostOfficeSuiteRows(input.sources, input.sourcesRoot)
	const lineageBase = { sources }

	const perCountry = new Map<string, number>()

	for (const row of rows) {
		perCountry.set(row.country!, (perCountry.get(row.country!) ?? 0) + 1)
	}

	const manifestPath = resolvePath(input.outDirectory, `${POST_OFFICE_SUITE_ID}.json`).toString()
	const lineagePath = resolvePath(input.outDirectory, `${POST_OFFICE_SUITE_ID}.lineage.json`).toString()

	const manifest = await writeHeldoutDataset(manifestPath, {
		datasetID: POST_OFFICE_SUITE_ID,
		createdAt: input.createdAt,
		drawnFrom: {
			manifest: `${POST_OFFICE_SUITE_ID}.lineage.json`,
			sha256: sha256Hex(canonicalJSON(lineageBase)),
			corpusVersion: null,
			files: sources.map((source) => `${source.id}@${source.vintage}`),
		},
		sampling: {
			method: "every-row",
			// No quota is applied: this is the largest country's row count.
			perCountry: Math.max(0, ...perCountry.values()),
			seed: null,
			order: "every row of every registered source, in source order, address form before venue-address form",
			engine: "mailwoman post-office-suite",
		},
		cells: countHeldoutCells(
			[...perCountry].map(([country, available]) => ({ country, kind: "address" as const, available })),
			rows
		),
		rows,
	})

	await writeLocalJSONFile({ ...lineageBase, rows: rows.length }, lineagePath)

	return { manifestPath, lineagePath, manifest, rows, sources }
}
