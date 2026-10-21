/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Count the train rows of a built corpus that still write each held-out region or locality name.
 *
 *   A holdout keyed on a name removes every row whose component holds that name. When no row of another
 *   place writes the same word, the holdout removes the word from training along with the place, and a
 *   model trained on the corpus has never seen it (#2777: `Illes Balears` and `Principado de Asturias`
 *   had 0 rows in v0.8.0 train). A postcode key leaves the word in train through the rows that write the
 *   place without a postcode.
 *
 *   The count reads the corpus manifest's file list: a file recorded under `split: "train"` counts every
 *   row, a file decided by a split attribute counts the rows whose `source_id` the attribute does not
 *   hold out, and a val or test file is not read. The name test is a whole-word, case-insensitive match
 *   on `raw`, because the word survives wherever the text writes it, whichever component it is labeled.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"

import { escapeSQLString, openDuckDB, type DuckDBLimits } from "#parquet/duckdb"
import { baseManifestFiles, localManifestFilePath } from "#tools/overlay/manifest"
import { readSplitAttribute } from "#tools/overlay/split-attribute"
import { type CountryHoldout, holdoutPolicyFor } from "#utils/split"

/**
 * One declared holdout name and the train rows of its country that write it.
 */
export interface HeldOutNameCount {
	country: string
	kind: "region" | "locality"
	name: string
	trainRows: number
}

export interface HeldOutNameCountResult {
	counts: HeldOutNameCount[]
	/**
	 * The train rows read, per declared country.
	 */
	countryTrainRows: Record<string, number>
	filesRead: number
}

/**
 * The RE2 pattern that finds `name` as a whole word in a row's text, ignoring case.
 */
export function heldOutNamePattern(name: string): string {
	const escaped = name.replaceAll(/[.*+?^${}()|[\]\\/]/gu, "\\$&")

	return `(?i)(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`
}

/**
 * Count, for every region and locality name `holdouts` declares, the train rows of its
 * country in the corpus `manifestPath` names whose text contains the name.
 *
 * @throws When a manifest file records neither a split nor a split attribute,
 * since reading it as train or skipping it would both misstate the count.
 */
export async function countHeldOutNameTrainRows(
	manifestPath: string,
	holdouts: Record<string, CountryHoldout>,
	limits?: DuckDBLimits
): Promise<HeldOutNameCountResult> {
	const files = baseManifestFiles(await readLocalJSONFile(manifestPath))
	const names: Array<Omit<HeldOutNameCount, "trainRows"> & { column: string }> = []

	for (const [country, holdout] of Object.entries(holdouts)) {
		const policy = holdoutPolicyFor(holdout)

		for (const name of policy.regions ?? []) {
			names.push({ country, kind: "region", name, column: `n${names.length}` })
		}

		for (const name of policy.localities ?? []) {
			names.push({ country, kind: "locality", name, column: `n${names.length}` })
		}
	}

	const countries = [...new Set(names.map((name) => name.country))]
	const countryRows: Record<string, number> = Object.fromEntries(countries.map((country) => [country, 0]))
	const totals = new Map<string, number>(names.map((name) => [name.column, 0]))

	if (!names.length) return { counts: [], countryTrainRows: countryRows, filesRead: 0 }

	const quoted = (value: string) => `'${escapeSQLString(value)}'`

	const selects = [
		...countries.map((country, index) => `count(*) FILTER (WHERE country = ${quoted(country)}) AS c${index}`),
		...names.map(
			(name) =>
				`count(*) FILTER (WHERE country = ${quoted(name.country)} AND ` +
				`regexp_matches(raw, ${quoted(heldOutNamePattern(name.name))})) AS ${name.column}`
		),
	].join(", ")

	using db = await openDuckDB(limits)

	await db.run("CREATE TEMP TABLE held_out_ids (id VARCHAR)")

	let filesRead = 0

	for (const file of files) {
		const split = file["split"]
		const reference = file["split_attribute"] as { path?: unknown } | undefined

		if (split === "val" || split === "test") continue

		if (split !== "train" && typeof reference?.path !== "string") {
			throw new Error(`${manifestPath} lists ${file.path} with neither a split nor a split attribute`)
		}

		await db.run("DELETE FROM held_out_ids")

		if (split !== "train") {
			const attribute = await readSplitAttribute(localManifestFilePath(reference!.path as string))
			const appender = await db.createAppender("held_out_ids")

			for (const id of [...attribute.val, ...attribute.test]) {
				appender.appendVarchar(id)
				appender.endRow()
			}

			appender.closeSync()
		}

		const row = (
			await db.runAndReadAll(
				`SELECT ${selects} FROM read_parquet(${quoted(localManifestFilePath(file.path))}) ` +
					`WHERE country IN (${countries.map(quoted).join(", ")}) ` +
					`AND source_id NOT IN (SELECT id FROM held_out_ids)`
			)
		).getRowObjectsJson()[0]!

		for (const [index, country] of countries.entries()) {
			countryRows[country]! += Number(row[`c${index}`])
		}

		for (const name of names) {
			totals.set(name.column, totals.get(name.column)! + Number(row[name.column]))
		}

		filesRead++
	}

	return {
		counts: names.map(({ column, ...name }) => ({ ...name, trainRows: totals.get(column)! })),
		countryTrainRows: countryRows,
		filesRead,
	}
}
