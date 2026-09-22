/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Count the train-split rows of a built corpus that the holdout policy says belong in val or test.
 *
 *   A holdout added to `defaultHoldouts()` takes effect at the next base rebuild, and an overlay
 *   never passes through the align loop that applies it. This reads what a finished corpus holds and
 *   answers the question directly: for each country the policy names, how many of its held-out rows
 *   are in the train split.
 *
 *   The matchers come from `defaultHoldouts()` rather than being restated here, so a prefix added to
 *   the policy is checked without editing this file.
 *
 *   The region and locality tests are exact equality and the postcode test is a prefix, which is what
 *   `splitForRow` applies. The predicate runs inside DuckDB over the parquet files rather than row by
 *   row in this process, because a base corpus holds over a hundred million train rows.
 *
 *   Usage:
 *   node packages/mailwoman/lib/dev-tools/corpus/holdout-leakage.run.ts --corpus <corpus dir>
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { connectDuckDB, escapeSQLString } from "@mailwoman/corpus/parquet/duckdb"
import { defaultHoldouts, holdoutPolicyFor } from "@mailwoman/corpus/utils/split"
import { join } from "path-ts"

const { values } = parseArguments({
	options: {
		corpus: { type: "string" },
		split: { type: "string", default: "train" },
	},
})

const corpus = values.corpus

if (!corpus) throw new Error("--corpus <corpus dir> is required")

const pattern = String(join(corpus, values.split!, "*.parquet"))

/**
 * The value of one component tag, read back out of `raw` at the offset the span triple records.
 *
 * DuckDB's `list_position` is one-based and returns NULL when the tag is absent,
 * and `substr` takes a one-based start with a length, so the start is `span_starts[i] + 1`
 * and the length is the span's width.
 */
function componentSQL(tag: string): string {
	const index = `list_position(span_tags, '${tag}')`

	return `CASE WHEN ${index} IS NULL THEN NULL ELSE substr(raw, span_starts[${index}] + 1, span_ends[${index}] - span_starts[${index}]) END`
}

const holdouts = defaultHoldouts()
const clauses: string[] = []

for (const [country, holdout] of Object.entries(holdouts)) {
	const policy = holdoutPolicyFor(holdout)
	const tests: string[] = []

	for (const region of policy.regions ?? []) {
		tests.push(`${componentSQL("region")} = '${escapeSQLString(region)}'`)
	}

	for (const locality of policy.localities ?? []) {
		tests.push(`${componentSQL("locality")} = '${escapeSQLString(locality)}'`)
	}

	for (const prefix of policy.postcodePrefixes ?? []) {
		tests.push(`${componentSQL("postcode")} LIKE '${escapeSQLString(prefix)}%'`)
	}

	if (!tests.length) continue

	clauses.push(`SUM(CASE WHEN country = '${country}' AND (${tests.join(" OR ")}) THEN 1 ELSE 0 END) AS ${country}`)
}

const db = await connectDuckDB()

const result = await db.runAndReadAll(
	`SELECT COUNT(*) AS rows, ${clauses.join(", ")} FROM read_parquet('${escapeSQLString(pattern)}', union_by_name = true)`
)

const [row] = result.getRowObjects()

if (!row) throw new Error(`read_parquet over ${pattern} answered no row`)

console.log(`${Number(row.rows).toLocaleString()} rows matched ${pattern}`)

let leaked = 0

for (const country of Object.keys(holdouts)) {
	const count = Number(row[country] ?? 0)

	leaked += count

	console.log(`  ${country}: ${count.toLocaleString()} rows the holdout policy names`)
}

console.log(
	leaked
		? `${leaked.toLocaleString()} held-out rows are in the ${values.split} split`
		: `no held-out row is in the ${values.split} split`
)
