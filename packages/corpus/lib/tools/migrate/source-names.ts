/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Rewrite a parquet file's `source` column from the retired spelling to the current one.
 *
 *   A recipe-output `source` is a wire identifier. It is stored on every row of every corpus carrying it,
 *   keyed by every training config that weights it, and quoted by every model card trained on it. The
 *   retired `synth-*` spelling says a row is fabricated where most of these rows are attested records a
 *   recipe rendered, spliced or fragmented. `RECIPE_SOURCES` in `#recipes/sources` holds both spellings and
 *   the operation each recipe performed.
 *
 *   The rewrite runs over an assembly's staging files before `overlay-manifest` computes each file's
 *   `sha256`, so the manifest describes the renamed bytes. A corpus already assembled is never rewritten in
 *   place: its manifest records digests over the bytes it has, and the configs that target it keep the
 *   spelling it stores.
 *
 *   **What the verification establishes.** Row count, distinct `source` set, and an md5 over the ordered
 *   `source_id` column are compared before and after. Those three together establish that the rewrite
 *   changed the `source` column and the row order of no other column. They do not establish that the
 *   output's other columns are unchanged, which a full-file digest cannot show either, because the rewrite
 *   re-encodes the file.
 */

import { md5Hex } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { escapeSQLIdentifier, escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { ROW_GROUP_SIZE } from "#parquet/schema"
import { currentSourceName } from "#recipes/sources"

/**
 * What one file's rewrite established.
 */
export interface SourceNameRewrite {
	parquet: string
	rows: number
	/**
	 * The mapping applied, keyed by the retired spelling.
	 *
	 * A file whose rows already carry current spellings is reported with an empty map and left untouched.
	 */
	renamed: Record<string, string>
	/**
	 * The md5 over the ordered `source_id` column, identical before and after.
	 */
	sourceIDDigest: string
}

/**
 * Read the distinct `source` values and the ordered-`source_id` digest of one parquet file.
 */
async function readSourceFacts(
	db: Awaited<ReturnType<typeof openDuckDB>>,
	path: string
): Promise<{ rows: number; sources: string[]; digest: string }> {
	const literal = escapeSQLString(path)

	const counted = await db.runAndReadAll(`SELECT COUNT(*) AS rows FROM read_parquet('${literal}')`)
	const rows = Number((counted.getRowObjectsJS()[0] as { rows: bigint | number }).rows)

	const distinct = await db.runAndReadAll(`SELECT DISTINCT source FROM read_parquet('${literal}') ORDER BY source`)

	const sources = (distinct.getRowObjectsJS() as Array<{ source: string }>).map((row) => row.source)

	// The digest reads `source_id` in file order rather than sorted, so a rewrite
	// that reordered rows produces a different value.
	// `preserve_insertion_order` is what keeps the order, and this is the check that it did.
	const ids = await db.runAndReadAll(`SELECT source_id FROM read_parquet('${literal}')`)
	const digest = md5Hex((ids.getRowObjectsJS() as Array<{ source_id: string }>).map((row) => row.source_id).join("\n"))

	return { rows, sources, digest }
}

/**
 * Rewrite one parquet file's `source` column in place, through a temporary output.
 *
 * @throws When a row carries a `source` the table does not name under either spelling.
 * An unknown value is refused rather than carried, because carrying it would leave one
 * file holding both spellings and no later reader could tell which rows were rewritten.
 * @throws When the row count, the distinct `source` count or the ordered-`source_id`
 * digest differs after the rewrite.
 */
export async function rewriteSourceNames(parquetPath: PathBuilderLike): Promise<SourceNameRewrite> {
	const path = PathBuilder.from(parquetPath)
	const pathString = path.toString()

	using db = await openDuckDB()

	await db.run("SET preserve_insertion_order=true")

	const before = await readSourceFacts(db, pathString)
	const renamed: Record<string, string> = {}
	const unknown: string[] = []

	for (const source of before.sources) {
		const current = currentSourceName(source)

		if (!current) {
			unknown.push(source)

			continue
		}

		if (current !== source) {
			renamed[source] = current
		}
	}

	if (unknown.length) {
		throw new Error(
			`${pathString} carries ${unknown.length} source value(s) that RECIPE_SOURCES names under neither ` +
				`spelling: ${unknown.join(", ")}. Add each to packages/corpus/lib/recipes/sources.ts, or to ` +
				`CARRIED_SOURCES where the name is already current, before rewriting this file.`
		)
	}

	if (!Object.keys(renamed).length) {
		return { parquet: pathString, rows: before.rows, renamed, sourceIDDigest: before.digest }
	}

	const cases = Object.entries(renamed)
		.map(([retired, current]) => `WHEN '${escapeSQLString(retired)}' THEN '${escapeSQLString(current)}'`)
		.join(" ")

	const staged = path.dirname()(`${path.basename()}.renamed`)
	const stagedString = staged.toString()

	await db.run(
		`COPY (SELECT * REPLACE (CASE source ${cases} ELSE source END AS ${escapeSQLIdentifier("source")}) ` +
			`FROM read_parquet('${escapeSQLString(pathString)}')) ` +
			`TO '${escapeSQLString(stagedString)}' (FORMAT PARQUET, COMPRESSION SNAPPY, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`
	)

	const after = await readSourceFacts(db, stagedString)

	if (after.rows !== before.rows) {
		throw new Error(
			`${pathString}: the rewrite wrote ${after.rows.toLocaleString()} rows and the input holds ` +
				`${before.rows.toLocaleString()}. ${stagedString} is left in place for inspection.`
		)
	}

	if (after.sources.length !== before.sources.length) {
		throw new Error(
			`${pathString}: the input holds ${before.sources.length} distinct source values and the rewrite ` +
				`wrote ${after.sources.length}. Two retired names mapping to one current name would do that, and it ` +
				`makes the two sources indistinguishable. ${stagedString} is left in place for inspection.`
		)
	}

	if (after.digest !== before.digest) {
		throw new Error(
			`${pathString}: the ordered source_id digest changed from ${before.digest} to ${after.digest}, so the ` +
				`rewrite reordered rows. ${stagedString} is left in place for inspection.`
		)
	}

	return { parquet: pathString, rows: before.rows, renamed, sourceIDDigest: before.digest }
}
