// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The census behind `validation/quota.run.ts`: each country's pool of held-out groups
 *   in a corpus manifest, and the validation floors the training config declares.
 *
 *   The pool is every group with a row the manifest's current split holds out
 *   (`val` or `test` in the split attribute or the file's split), less the frozen groups.
 *   A group's rows are counted over the files that hold one of its held-out rows.
 *
 *   A street row has a span tagged `street` or `house_number`, the tags the
 *   validation-coverage audit counts.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { recordIDSQL } from "@mailwoman/corpus/adapters/record-id"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { parquetColumnNames } from "@mailwoman/corpus/parquet/readers"
import { localManifestFilePath } from "@mailwoman/corpus/tools/overlay/manifest"
import { weightedCountries } from "@mailwoman/corpus/training/config/load"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import type { EvaluationGroups } from "@mailwoman/corpus/utils/evaluation-groups"
import type { ValidationCandidate, ValidationFloor } from "@mailwoman/corpus/utils/validation-groups"

import { expandRequirements, STREET_TAGS } from "#tools/training/audits/validation/coverage"

/**
 * Each country's `val` floor, from the config's `required_validation_coverage` with every `*`
 * entry expanded to the admitted countries, as the preflight's coverage audit expands it.
 */
export function validationFloorsFromConfig(config: TrainingConfig): Map<string, ValidationFloor> {
	const floors = new Map<string, ValidationFloor>()

	for (const entry of expandRequirements(config.data.required_validation_coverage, weightedCountries(config))) {
		if (entry.split !== "val") continue

		const earlier = floors.get(entry.country)

		floors.set(entry.country, {
			minRows: Math.max(earlier?.minRows ?? 0, entry.min_rows),
			minStreetRows: Math.max(earlier?.minStreetRows ?? 0, entry.min_street_rows),
		})
	}

	return floors
}

interface CensusManifestFile {
	path: string
	rows: number
	split?: string
	split_attribute?: { path: string }
}

/**
 * A country's whole held-out pool.
 */
export interface ValidationPoolTotal {
	rows: number
	streetRows: number
	groups: number
}

/**
 * Reads a manifest's held-out pool.
 *
 * Returns each country's pool totals, and the head of each country's pool in `hashUint32`
 * order up to the group that crosses `capRows`, which is every group the quota can take.
 *
 * @throws When a file records neither a split attribute nor a split,
 * since its held-out rows are then unknown.
 */
export async function readValidationPool(input: {
	manifest: string
	frozen: Pick<EvaluationGroups, "groups">
	capRows: number
	onProgress?: (filesRead: number, files: number) => void
}): Promise<{ candidates: ValidationCandidate[]; totals: Map<string, ValidationPoolTotal>; files: number }> {
	const manifest = await readLocalJSONFile<{ files?: CensusManifestFile[] }>(input.manifest)
	const files = manifest.files ?? []

	if (!files.length) throw new Error(`${input.manifest} lists no files`)

	using db = await openDuckDB({ threads: 2, memoryLimitBytes: 4 * 1024 ** 3 })

	await db.run(`CREATE TEMP TABLE frozen (k VARCHAR PRIMARY KEY)`)

	const frozen = [...input.frozen.groups]

	for (let i = 0; i < frozen.length; i += 1000) {
		const values = frozen
			.slice(i, i + 1000)
			.map((group) => `('${escapeSQLString(group)}')`)
			.join(", ")

		await db.run(`INSERT INTO frozen VALUES ${values}`)
	}

	await db.run(`CREATE TEMP TABLE pool (country VARCHAR, g VARCHAR, n BIGINT, st BIGINT)`)

	const streetTags = [...STREET_TAGS].map((tag) => `'${escapeSQLString(tag)}'`).join(", ")

	for (const [index, file] of files.entries()) {
		const local = localManifestFilePath(file.path)
		const quoted = `read_parquet('${escapeSQLString(local)}')`
		const columns = await parquetColumnNames(local)
		// A file with no base_source_id column records no derivation, so each row is its own group.
		const base = columns.includes("base_source_id") ? "t.base_source_id" : "CAST(NULL AS VARCHAR)"
		let held: string

		if (file.split_attribute) {
			const attribute = `'${escapeSQLString(localManifestFilePath(file.split_attribute.path))}'`
			const options = "maximum_object_size = 160000000, columns = {val: 'VARCHAR[]', test: 'VARCHAR[]'}"

			held =
				`SELECT unnest(val) AS id FROM read_json(${attribute}, ${options}) ` +
				`UNION ALL SELECT unnest(test) AS id FROM read_json(${attribute}, ${options})`
		} else if (file.split === "val" || file.split === "test") {
			held = `SELECT source_id AS id FROM ${quoted}`
		} else if (file.split === "train") {
			continue
		} else {
			throw new Error(`${file.path} records neither a split attribute nor a split; its held-out rows are unknown`)
		}

		await db.run(
			`INSERT INTO pool WITH held AS (${held}), ` +
				// A row with no country counts under `(none)`, as the validation-coverage audit counts it.
				`r AS (SELECT coalesce(nullif(t.country, ''), '(none)') AS country, ` +
				`${recordIDSQL(`coalesce(${base}, t.source_id)`)} AS g, ` +
				`list_has_any(t.span_tags, [${streetTags}]) AS st, h.id IS NOT NULL AS is_held ` +
				`FROM ${quoted} t LEFT JOIN held h ON h.id = t.source_id) ` +
				`SELECT country, g, count(*), sum(CASE WHEN st THEN 1 ELSE 0 END) FROM r ` +
				`GROUP BY country, g HAVING bool_or(is_held) AND g NOT IN (SELECT k FROM frozen)`
		)

		input.onProgress?.(index + 1, files.length)
	}

	// The hash is `hashUint32`'s: the first four bytes of the group's sha256 as a big-endian uint32.
	await db.run(
		`CREATE TEMP TABLE groups AS SELECT country, g, sum(n) AS n, sum(st) AS st, ` +
			`CAST(('0x' || substr(sha256(g), 1, 8)) AS UBIGINT) AS h FROM pool GROUP BY country, g`
	)

	const totals = new Map<string, ValidationPoolTotal>()

	for (const row of (
		await db.runAndReadAll(
			`SELECT country, sum(n) AS n, sum(st) AS st, count(*) AS groups FROM groups GROUP BY country`
		)
	).getRowObjects()) {
		totals.set(String(row.country), { rows: Number(row.n), streetRows: Number(row.st), groups: Number(row.groups) })
	}

	const head = await db.runAndReadAll(
		`SELECT country, g, n, st FROM (SELECT *, sum(n) OVER (PARTITION BY country ORDER BY h, g ` +
			`ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) - n AS before FROM groups) ` +
			`WHERE before < ${Math.floor(input.capRows)}`
	)

	const candidates = head.getRowObjects().map((row) => ({
		country: String(row.country),
		group: String(row.g),
		rows: Number(row.n),
		streetRows: Number(row.st),
	}))

	return { candidates, totals, files: files.length }
}
