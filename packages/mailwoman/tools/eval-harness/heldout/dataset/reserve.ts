// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A forward reserve: groups drawn from a corpus's training pool for the next
 *   cycle's confirmation collection.
 *
 *   A confirmation collection drawn from a build's held-out places holds only the
 *   rows that build adds, so a build that adds few rows for a country leaves that
 *   country under its group target (the v14 record, section 7).
 *   A reserve takes whole groups out of the training pool before the re-split,
 *   so the candidate trained on that re-split never reads them.
 *
 *   The reserve's manifest is listed in the evaluation-group list beside the collections
 *   frozen with it (`evaluation-groups.run.ts --datasets`), which sends its groups to test.
 *   The next cycle's confirmation collection is then frozen from those rows.
 *
 *   The draw is stated in groups: `groupsPerCountry` groups per country and row kind,
 *   the lowest `hash(group, seed)` first, from train rows only (`stageTrainRows`:
 *   a split attribute's `val` and `test` ids and a manifest deletion's ids are left out).
 *   A group is eligible when none of its rows is held out, when no excluded collection
 *   holds it, and when no training receipt requires it (`required-groups`).
 *
 *   The manifest records one row per record of each drawn group, as the freeze does,
 *   and the collection kind `reserve`.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { recordIDSQL } from "@mailwoman/corpus/adapters/record-id"
import { type DisposableDuckDB, type DuckDBLimits, escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { parquetColumnNames } from "@mailwoman/corpus/parquet/readers"
import { normalizeDuckDBValue } from "@mailwoman/corpus/parquet/streams"
import type { CorpusDeletion } from "@mailwoman/corpus/tools/overlay/deletions"
import { baseManifestFiles, localManifestFilePath } from "@mailwoman/corpus/tools/overlay/manifest"
import { stageTrainRows, type TrainManifestFile } from "@mailwoman/corpus/tools/support-index"

import {
	gazetteerSourceSQL,
	HELDOUT_GAZETTEER_SOURCES,
	type HeldoutCellCount,
	type HeldoutRow,
	type HeldoutRowKind,
	heldoutRowGroup,
	heldoutRowKind,
	type HeldoutSampleExclusion,
	type HeldoutSamplingRule,
	heldoutSampleOrder,
} from "#tools/eval-harness/heldout/per/country"
import {
	createRequiredGroupsTable,
	requiredGroupSkip,
	requiredGroupSQL,
	type RequiredTrainingGroups,
} from "#tools/training/audits/required-groups"

/**
 * The input of {@linkcode sampleReserveRows}.
 */
export interface ReserveDrawInput {
	/**
	 * The corpus `MANIFEST.json` whose training pool the reserve is drawn from.
	 */
	manifest: string
	/**
	 * Groups drawn per country and row kind.
	 */
	groupsPerCountry: number
	seed: number | null
	limits?: DuckDBLimits
	/**
	 * Frozen collections whose groups the reserve never draws.
	 */
	exclusions?: readonly HeldoutSampleExclusion[]
	/**
	 * The groups the next training config's receipts require.
	 * The reserve never draws them.
	 */
	required?: RequiredTrainingGroups | null
	onProgress?: (pass: string, filesRead: number, files: number) => void
}

const quote = (value: string) => `'${escapeSQLString(value)}'`

/**
 * A file's base id column, `NULL` for a file that records no derivation, where each row is its own group.
 */
async function baseColumnSQL(file: TrainManifestFile): Promise<string> {
	const columns = await parquetColumnNames(localManifestFilePath(file.path))

	return columns.includes("base_source_id") ? "CAST(base_source_id AS VARCHAR)" : "CAST(NULL AS VARCHAR)"
}

/**
 * A row's group, `heldoutRowGroup`'s, over the unqualified corpus columns.
 */
function groupSQL(base: string): string {
	return recordIDSQL(`coalesce(${base}, CAST(source_id AS VARCHAR))`)
}

/**
 * Inserts the groups of every held-out row of `file` into `held`: all of a `val`
 * or `test` file's rows, and a split attribute's `val` and `test` ids.
 */
async function insertHeldGroups(db: DisposableDuckDB, file: TrainManifestFile): Promise<void> {
	const parquet = `read_parquet(${quote(localManifestFilePath(file.path))})`
	const split = file["split"]
	const reference = file["split_attribute"] as { path?: unknown } | undefined
	const group = groupSQL(await baseColumnSQL(file))

	if (split === "val" || split === "test") {
		await db.run(`INSERT INTO held SELECT DISTINCT ${group} FROM ${parquet}`)

		return
	}

	if (typeof split === "string" || typeof reference?.path !== "string") return

	const attribute = quote(localManifestFilePath(reference.path))
	const options = "maximum_object_size = 160000000, columns = {val: 'VARCHAR[]', test: 'VARCHAR[]'}"

	await db.run(
		`INSERT INTO held SELECT DISTINCT ${group} FROM ${parquet} WHERE source_id IN (` +
			`SELECT unnest(val) FROM read_json(${attribute}, ${options}) UNION ALL ` +
			`SELECT unnest(test) FROM read_json(${attribute}, ${options}))`
	)
}

/**
 * Draws a reserve from a corpus's training pool, as the rows of a held-out dataset manifest.
 *
 * It reads the manifest's files three times: their held-out groups, their eligible
 * train groups in hash order, and the drawn groups' rows.
 * No row is drawn twice, since a group belongs to one reserve cell per country and kind.
 */
export async function sampleReserveRows(input: ReserveDrawInput): Promise<{
	rows: HeldoutRow[]
	counts: HeldoutCellCount[]
	files: string[]
	rule: HeldoutSamplingRule
}> {
	const perCell = Math.trunc(input.groupsPerCountry)

	if (!(perCell > 0)) throw new Error(`a reserve draws a positive number of groups per country; received ${perCell}`)

	const manifest = await readLocalJSONFile<{ deletions?: CorpusDeletion[] }>(input.manifest)
	const files = baseManifestFiles<TrainManifestFile>(manifest)

	if (!files.length) throw new Error(`${input.manifest} lists no files`)

	const deletions = manifest.deletions ?? []
	const exclusions = input.exclusions ?? []
	const required = input.required ?? null
	const order = input.seed == null ? "hash(g)" : `hash(g, ${Math.trunc(input.seed).toString()})`
	const gazetteer = gazetteerSourceSQL("source")

	using db = await openDuckDB(input.limits)

	await db.run("CREATE TEMP TABLE excluded_ids (id VARCHAR)")
	await db.run("CREATE TEMP TABLE held (g VARCHAR)")
	await db.run("CREATE TEMP TABLE excluded_groups (k VARCHAR)")
	await db.run("CREATE TEMP TABLE candidates (country VARCHAR, gazetteer BOOLEAN, g VARCHAR, h UBIGINT)")
	await db.run("CREATE TEMP TABLE skipped (country VARCHAR, g VARCHAR)")
	await createRequiredGroupsTable(db, required ?? { records: new Map() })

	const excluded = [...new Set(exclusions.flatMap((exclusion) => exclusion.groups))]

	for (let start = 0; start < excluded.length; start += 5000) {
		await db.run(
			`INSERT INTO excluded_groups VALUES ${excluded
				.slice(start, start + 5000)
				.map((group) => `(${quote(group)})`)
				.join(", ")}`
		)
	}

	for (const [index, file] of files.entries()) {
		await insertHeldGroups(db, file)
		input.onProgress?.("held-out groups", index + 1, files.length)
	}

	const read: string[] = []

	for (const [index, file] of files.entries()) {
		const group = groupSQL(await baseColumnSQL(file))

		const staged = await stageTrainRows(
			db,
			input.manifest,
			file,
			deletions,
			`coalesce(nullif(country, ''), 'ZZ') AS country, ${gazetteer} AS gazetteer, ${group} AS g`,
			input.limits,
			`${group} NOT IN (SELECT k FROM excluded_groups)`
		)

		input.onProgress?.("train groups", index + 1, files.length)

		if (staged == null) continue

		read.push(localManifestFilePath(file.path))

		if (!staged) continue

		await db.run(`INSERT INTO skipped SELECT DISTINCT country, g FROM r WHERE ${requiredGroupSQL("g")}`)

		// Only the head of each cell in hash order can be drawn, so each file keeps its first `perCell` groups per cell.
		await db.run(
			`INSERT INTO candidates SELECT country, gazetteer, g, ${order} AS h FROM ` +
				`(SELECT DISTINCT country, gazetteer, g FROM r WHERE NOT ${requiredGroupSQL("g")} AND g NOT IN (SELECT g FROM held)) ` +
				`QUALIFY row_number() OVER (PARTITION BY country, gazetteer ORDER BY h, g) <= ${perCell}`
		)
	}

	await db.run(
		"CREATE TEMP TABLE drawn AS SELECT DISTINCT country, gazetteer, g FROM candidates " +
			`QUALIFY dense_rank() OVER (PARTITION BY country, gazetteer ORDER BY h, g) <= ${perCell}`
	)

	await db.run(
		"CREATE TEMP TABLE reserve_rows (raw VARCHAR, span_starts INTEGER[], span_ends INTEGER[], span_tags VARCHAR[], " +
			"country VARCHAR, source VARCHAR, source_id VARCHAR, base_source_id VARCHAR)"
	)

	for (const [index, file] of files.entries()) {
		const base = await baseColumnSQL(file)

		const staged = await stageTrainRows(
			db,
			input.manifest,
			file,
			deletions,
			"raw, span_starts, span_ends, span_tags, country, source, CAST(source_id AS VARCHAR) AS source_id, " +
				`${base} AS base_source_id`,
			input.limits,
			`${groupSQL(base)} IN (SELECT g FROM drawn)`
		)

		input.onProgress?.("reserve rows", index + 1, files.length)

		if (staged) {
			await db.run("INSERT INTO reserve_rows SELECT * FROM r")
		}
	}

	// One row per record, the first in the freeze's sample order, as `sampleHeldoutRows` keeps them.
	// A row counts toward the cell its own group was drawn in.
	const reader = await db.runAndReadAll(
		`SELECT DISTINCT t.* FROM reserve_rows t JOIN drawn d ON d.g = ${recordIDSQL("coalesce(t.base_source_id, t.source_id)")} ` +
			`AND d.country = coalesce(nullif(t.country, ''), 'ZZ') AND d.gazetteer = ${gazetteerSourceSQL("t.source")} ` +
			`QUALIFY t.source_id IS NULL OR row_number() OVER (PARTITION BY t.source, ${recordIDSQL("t.source_id")} ` +
			`ORDER BY ${heldoutSampleOrder(input.seed)}) = 1 ` +
			`ORDER BY coalesce(t.country, 'ZZ'), ${gazetteerSourceSQL("t.source")}, ${heldoutSampleOrder(input.seed)}`
	)

	const list = (value: unknown): unknown[] => {
		const normalized = normalizeDuckDBValue(value)

		if (!Array.isArray(normalized)) throw new Error(`a reserve row holds a non-list span column: ${String(normalized)}`)

		return normalized
	}

	const rows = reader.getRowObjects().map((row): HeldoutRow => ({
		group: heldoutRowGroup(row, `${String(row.source)}:${String(row.source_id)}`),
		raw: String(row.raw),
		span_starts: list(row.span_starts).map(Number),
		span_ends: list(row.span_ends).map(Number),
		span_tags: list(row.span_tags).map((tag) => String(tag) as HeldoutRow["span_tags"][number]),
		country: row.country == null ? null : String(row.country),
		source: String(row.source),
		source_id: row.source_id == null ? null : String(row.source_id),
	}))

	const cells = (
		await db.runAndReadAll("SELECT country, gazetteer, count(*) AS groups FROM drawn GROUP BY ALL ORDER BY ALL")
	)
		.getRowObjects()
		.map((row) => ({
			country: String(row.country),
			kind: (row.gazetteer === true ? "gazetteer" : "address") as HeldoutRowKind,
			groups: Number(row.groups),
		}))

	const counts: HeldoutCellCount[] = cells.map((cell) => {
		const sampled = rows.filter(
			(row) => (row.country ?? "ZZ") === cell.country && heldoutRowKind(row.source) === cell.kind
		).length

		return { country: cell.country, kind: cell.kind, available: sampled, sampled }
	})

	const skipped = required
		? requiredGroupSkip(
				required,
				new Map(
					(await db.runAndReadAll("SELECT country, count(DISTINCT g) AS n FROM skipped GROUP BY ALL"))
						.getRowObjects()
						.map((row) => [String(row.country), Number(row.n)] as const)
				)
			)
		: null

	const [against, ...readSets] = exclusions.map(({ datasetID, version }) => ({ datasetID, version }))

	return {
		rows,
		counts,
		files: read,
		rule: {
			method: "per-group-train-pool-hash-order",
			perCountry: perCell,
			seed: input.seed,
			order: `${order} per country and row kind, over train groups no held-out row, excluded collection or receipt holds`,
			reserveGroups: cells,
			...(against ? { excludes: against } : {}),
			...(readSets.length ? { excludesRead: readSets } : {}),
			...(skipped ? { requiredTrainingGroups: skipped } : {}),
			gazetteerSources: HELDOUT_GAZETTEER_SOURCES,
		},
	}
}
