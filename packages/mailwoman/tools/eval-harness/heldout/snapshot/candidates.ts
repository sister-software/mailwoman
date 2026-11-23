// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Evaluation candidates from a newer snapshot of a source the corpus adapters
 *   already read (HOLDOUT_AND_EVALUATION section 6.4): the snapshot's records that
 *   no training corpus and no frozen collection holds.
 *
 *   The source's own adapter reads the snapshot, and the build's row aligner (`createRowAligner`)
 *   labels each base row with its license, eligibility and component checks, without augmentation.
 *   A labeled row is then kept only when its `source:source_id` identity, its group
 *   and its folded text (`overlapTextFoldSQL`) appear in none of the source's rows in
 *   any listed corpus, in any split, and in no listed frozen collection.
 *
 *   The kept rows are written as one parquet file under a manifest whose files are `test`,
 *   so `heldout/dataset/freeze.run.ts` draws from them as it draws from a corpus's test split.
 *   The overlap audit (`heldout/dataset/overlap.run.ts --match-text`) then classes
 *   the drawn rows against every source of both training lineages.
 */

import { sha256File } from "@mailwoman/core/crypto/hash"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { openWriteStream } from "@mailwoman/core/fs/streams"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { recordIDSQL } from "@mailwoman/corpus/adapters/record-id"
import type { UnitSplitter } from "@mailwoman/corpus/adapters/street/unit"
import { type AlignTally, createRowAligner, emptyAlignResult } from "@mailwoman/corpus/build/align"
import { createIneligibilityReader } from "@mailwoman/corpus/build/eligibility"
import type { RegionNames } from "@mailwoman/corpus/build/region-names"
import { type DuckDBLimits, escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { flushStream, once } from "@mailwoman/corpus/runner"
import { baseManifestFiles } from "@mailwoman/corpus/tools/overlay/manifest"
import type { AdapterOptions, CorpusAdapter } from "@mailwoman/corpus/types"
import { createLicenseVerdictCache, LicensePolicy } from "@mailwoman/license/policy"
import { resolvePath } from "path-ts"

import { readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"
import { overlapTextFoldSQL } from "#tools/eval-harness/heldout/dataset/overlap"

/**
 * What one country's snapshot records came to.
 */
export interface SnapshotCountryCounts {
	country: string
	/**
	 * Rows the aligner labeled.
	 */
	labeled: number
	/**
	 * Labeled rows whose identity or group a corpus or frozen collection holds.
	 */
	excludedByIdentity: number
	/**
	 * Further rows whose folded text a corpus or frozen collection holds.
	 */
	excludedByText: number
	/**
	 * Further rows repeating an earlier kept row's folded text.
	 */
	repeatedText: number
	kept: number
}

/**
 * The record written beside the candidates' manifest.
 */
export interface SnapshotCandidatesRecord {
	source: string
	/**
	 * The snapshot read and the fetch record its fetcher wrote beside it.
	 */
	snapshot: { path: string; fetchRecord: unknown }
	corpora: Array<{ manifest: string; sha256: string; files: number }>
	datasets: Array<{ datasetID: string; version: string; rows: number }>
	/**
	 * Base rows the adapter yielded, and what the aligner refused or quarantined of them.
	 */
	align: {
		offered: number
		labeled: number
		quarantined: number
		excludedByLicense: number
		excludedByEligibility: number
	}
	countries: SnapshotCountryCounts[]
}

/**
 * The candidates' manifest path under `outDirectory`.
 */
export function snapshotCandidatesManifestPath(outDirectory: string, source: string): string {
	return resolvePath(outDirectory, `${source}.candidates.MANIFEST.json`).toString()
}

/**
 * Reads `adapter` over its snapshot, labels each base row and keeps the rows no corpus or collection holds.
 *
 * @throws When a corpus lists no file of the adapter's source.
 * An unread corpus would make the exclusion silently empty.
 */
export async function writeUnreadRows(input: {
	adapter: CorpusAdapter
	/**
	 * One adapter run per input file of the snapshot, such as BAN's one file per département.
	 */
	adapterOptions: readonly AdapterOptions[]
	/**
	 * The fetch record of the snapshot, such as the fetcher's `MANIFEST.json`.
	 */
	fetchRecord: unknown
	/**
	 * Training corpus manifests, read in every split.
	 */
	corpora: readonly string[]
	/**
	 * Frozen collection manifests.
	 */
	datasets: readonly string[]
	outDirectory: string
	pathRoot: string
	units: UnitSplitter
	regions: RegionNames | null
	limits?: DuckDBLimits
	report?: (line: string) => void
}): Promise<SnapshotCandidatesRecord> {
	const source = input.adapter.id
	const quote = (value: string) => `'${escapeSQLString(value)}'`

	await makeDirectories(input.outDirectory)

	const labeledPath = resolvePath(input.outDirectory, `${source}.labeled.jsonl`).toString()
	const quarantinePath = resolvePath(input.outDirectory, `${source}.quarantine.jsonl`).toString()
	const parquetPath = resolvePath(input.outDirectory, `${source}.candidates.parquet`).toString()

	// The adapter's own rows, labeled as a build labels them, with no augmentation.
	const licenses = createLicenseVerdictCache(LicensePolicy.All)
	const ineligibility = createIneligibilityReader(null)
	const result = emptyAlignResult(licenses, ineligibility.refused)

	const tally: AlignTally = {
		aligned: 0,
		quarantined: 0,
		excludedByLicense: 0,
		admittedUnresolved: 0,
		excludedByEligibility: 0,
	}

	const labeled = openWriteStream(labeledPath, { encoding: "utf8" })
	const quarantine = openWriteStream(quarantinePath, { encoding: "utf8" })
	let offered = 0

	const align = createRowAligner({
		synthesize: false,
		holdouts: {},
		licenses,
		ineligibility,
		units: input.units,
		regions: input.regions,
		result,
		tally,
		sinks: { labeled: (_split, line) => labeled.write(line), quarantine: (line) => quarantine.write(line) },
	})

	for (const options of input.adapterOptions) {
		for await (const row of input.adapter.rows(options)) {
			offered++
			align(row)

			// The sinks write synchronously, so the loop waits here for a full buffer to drain.
			for (const stream of [labeled, quarantine]) {
				if (stream.writableNeedDrain) {
					await once(stream, "drain")
				}
			}

			if (offered % 1_000_000 === 0) {
				input.report?.(`  ${source}: ${offered.toLocaleString("en-US")} rows read`)
			}
		}
	}

	for (const stream of [labeled, quarantine]) {
		await flushStream(stream)
		stream.end()
		await once(stream, "close")
	}

	input.report?.(
		`  ${source}: ${offered.toLocaleString("en-US")} read, ${tally.aligned.toLocaleString("en-US")} labeled`
	)

	using db = await openDuckDB(input.limits ?? {})

	await db.run(`CREATE TEMP TABLE held_ids (id VARCHAR)`)
	await db.run(`CREATE TEMP TABLE held_groups (g VARCHAR)`)
	await db.run(`CREATE TEMP TABLE held_texts (t VARCHAR)`)

	const corpora: SnapshotCandidatesRecord["corpora"] = []

	for (const corpus of input.corpora) {
		const entries = baseManifestFiles<{ path: string; source?: string }>(
			await readLocalJSONFile<object>(corpus)
		).filter((entry) => entry.source === source)

		if (!entries.length) throw new Error(`${corpus} lists no file of ${source}`)

		const files = `[${entries.map((entry) => quote(entry.path.replace(/^\/data/u, input.pathRoot))).join(", ")}]`
		const read = `read_parquet(${files}, union_by_name = true)`

		await db.run(`INSERT INTO held_ids SELECT DISTINCT CAST(source_id AS VARCHAR) FROM ${read}`)

		await db.run(
			`INSERT INTO held_groups SELECT DISTINCT ` +
				`${recordIDSQL("coalesce(CAST(base_source_id AS VARCHAR), CAST(source_id AS VARCHAR))")} FROM ${read}`
		)

		await db.run(`INSERT INTO held_texts SELECT DISTINCT ${overlapTextFoldSQL("raw")} FROM ${read}`)

		corpora.push({ manifest: corpus, sha256: await sha256File(corpus), files: entries.length })
		input.report?.(`  ${source}: read ${entries.length} files of ${corpus}`)
	}

	const datasets: SnapshotCandidatesRecord["datasets"] = []

	await db.run(`CREATE TEMP TABLE frozen (id VARCHAR, g VARCHAR, raw VARCHAR)`)

	for (const path of input.datasets) {
		const { manifest, rows } = await readHeldoutDatasetRows(path)

		for (let start = 0; start < rows.length; start += 2000) {
			const values = rows
				.slice(start, start + 2000)
				.map((row) => `(${quote(String(row.source_id))}, ${quote(row.group)}, ${quote(row.raw)})`)

			await db.run(`INSERT INTO frozen VALUES ${values.join(", ")}`)
		}

		datasets.push({ datasetID: manifest.datasetID, version: manifest.version, rows: rows.length })
	}

	await db.run(`INSERT INTO held_ids SELECT id FROM frozen`)
	await db.run(`INSERT INTO held_groups SELECT g FROM frozen`)
	await db.run(`INSERT INTO held_texts SELECT ${overlapTextFoldSQL("raw")} FROM frozen`)

	await db.run(
		`CREATE TEMP TABLE labeled AS SELECT raw, span_starts, span_ends, span_tags, country, source, source_id, ` +
			`${recordIDSQL("source_id")} AS g, ${overlapTextFoldSQL("raw")} AS t FROM read_json(${quote(labeledPath)}, ` +
			`format = 'newline_delimited', columns = {raw: 'VARCHAR', span_starts: 'INTEGER[]', span_ends: 'INTEGER[]', ` +
			`span_tags: 'VARCHAR[]', country: 'VARCHAR', source: 'VARCHAR', source_id: 'VARCHAR'})`
	)

	// Each row takes the first reason that keeps it out: identity or group, then text, then a repeat of a kept text.
	await db.run(
		`CREATE TEMP TABLE classed AS SELECT *, CASE ` +
			`WHEN source_id IN (SELECT id FROM held_ids) OR g IN (SELECT g FROM held_groups) THEN 'identity' ` +
			`WHEN t IN (SELECT t FROM held_texts) THEN 'text' ` +
			`WHEN row_number() OVER (PARTITION BY t ORDER BY source_id) > 1 THEN 'repeat' ` +
			`ELSE 'kept' END AS class FROM labeled`
	)

	await db.run(
		`COPY (SELECT raw, span_starts, span_ends, span_tags, country, source, source_id, ` +
			`CAST(NULL AS VARCHAR) AS base_source_id FROM classed WHERE class = 'kept' ORDER BY source_id) ` +
			`TO ${quote(parquetPath)} (FORMAT PARQUET)`
	)

	const counts = await db.runAndReadAll(
		`SELECT coalesce(country, 'ZZ') AS country, count(*) AS labeled, ` +
			`count(*) FILTER (WHERE class = 'identity') AS identity, count(*) FILTER (WHERE class = 'text') AS text, ` +
			`count(*) FILTER (WHERE class = 'repeat') AS repeat, count(*) FILTER (WHERE class = 'kept') AS kept ` +
			`FROM classed GROUP BY ALL ORDER BY country`
	)

	const countries = counts.getRowObjects().map((row): SnapshotCountryCounts => ({
		country: String(row.country),
		labeled: Number(row.labeled),
		excludedByIdentity: Number(row.identity),
		excludedByText: Number(row.text),
		repeatedText: Number(row.repeat),
		kept: Number(row.kept),
	}))

	const kept = countries.reduce((n, c) => n + c.kept, 0)
	const inputPath = input.adapterOptions.map((options) => String(options.inputPath)).join(", ")

	const record: SnapshotCandidatesRecord = {
		source,
		snapshot: { path: inputPath, fetchRecord: input.fetchRecord },
		corpora,
		datasets,
		align: {
			offered,
			labeled: tally.aligned,
			quarantined: tally.quarantined,
			excludedByLicense: tally.excludedByLicense,
			excludedByEligibility: tally.excludedByEligibility,
		},
		countries,
	}

	// The manifest freeze.run.ts reads: one test file of the kept rows.
	await writeLocalJSONFile(
		{
			corpus_version: `snapshot-candidates-${source}`,
			note: `Rows of ${inputPath} that no listed corpus or frozen collection holds (heldout/snapshot/candidates.ts)`,
			candidates: record,
			files: [{ path: parquetPath, split: "test", source, rows: kept }],
		},
		snapshotCandidatesManifestPath(input.outDirectory, source)
	)

	input.report?.(`  ${source}: kept ${kept.toLocaleString("en-US")} rows; ${stringifyJSON(countries)}`)

	return record
}
