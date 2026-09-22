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

import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { connectDuckDB, escapeSQLString } from "@mailwoman/corpus/parquet/duckdb"
import { componentAtSpanSQL } from "@mailwoman/corpus/parquet/span-sql"
import { normalizeDuckDBValue } from "@mailwoman/corpus/parquet/streams"
import { holdoutComponents } from "@mailwoman/corpus/tools"
import { defaultHoldouts, holdoutPolicyFor, splitForRow } from "@mailwoman/corpus/utils/split"
import { join } from "path-ts"

const { values } = parseArguments({
	options: {
		corpus: { type: "string" },
		split: { type: "string", default: "train" },
		show: {
			type: "string",
			description: "Print up to this many of the offending rows, with the address and the matched component",
		},
	},
})

const corpus = values.corpus

if (!corpus) throw new Error("--corpus <corpus dir> is required")

const pattern = String(join(corpus, values.split!, "*.parquet"))

const holdouts = defaultHoldouts()
const clauses: string[] = []
/**
 * One predicate per country, kept so an offending row can be read back after the count.
 *
 * A count says how many rows the policy names.
 * It does not say which, and the two cases differ: a row whose `region` span holds a
 * holdout name is the policy working on data the split missed, while a row whose `locality`
 * happens to equal one is the policy matching a name that is not a region.
 */
const predicates = new Map<string, string>()

for (const [country, holdout] of Object.entries(holdouts)) {
	const policy = holdoutPolicyFor(holdout)
	const tests: string[] = []

	for (const region of policy.regions ?? []) {
		tests.push(`${componentAtSpanSQL("region")} = '${escapeSQLString(region)}'`)
	}

	for (const locality of policy.localities ?? []) {
		tests.push(`${componentAtSpanSQL("locality")} = '${escapeSQLString(locality)}'`)
	}

	for (const prefix of policy.postcodePrefixes ?? []) {
		tests.push(`${componentAtSpanSQL("postcode")} LIKE '${escapeSQLString(prefix)}%'`)
	}

	if (!tests.length) continue

	predicates.set(country, `country = '${country}' AND (${tests.join(" OR ")})`)
	clauses.push(`SUM(CASE WHEN ${predicates.get(country)} THEN 1 ELSE 0 END) AS ${country}`)
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

/**
 * How many flagged rows are read back for confirmation.
 *
 * The SQL count is a candidate set rather than an answer.
 * `substr` counts characters and a span records UTF-16 code units, so a row carrying an
 * astral character slices 1 unit late per such character: `𐍀𐍂𐍉𐍆𐌹𐌳𐌰𐌹𐌽𐍃, RHODE ISLAND`
 * read its region as `ND`, taken from `ISLAND`, and matched North Dakota.
 *
 * Reading each flagged row through `holdoutComponents` and `splitForRow` settles
 * it with the same functions the corpus writer used.
 */
const CONFIRM_LIMIT = 10_000

if (leaked) {
	console.log(`confirming ${leaked.toLocaleString()} flagged rows through splitForRow`)

	let confirmed = 0
	const shown = values.show ? Number(values.show) : 0

	for (const [country, predicate] of predicates) {
		if (!Number(row[country] ?? 0)) continue

		const flagged = await db.runAndReadAll(
			`SELECT raw, source, source_id, country, span_starts, span_ends, span_tags
			 FROM read_parquet('${escapeSQLString(pattern)}', union_by_name = true)
			 WHERE ${predicate} LIMIT ${CONFIRM_LIMIT}`
		)

		// A DuckDB list column arrives as `{ items: [...] }`, so the span triple has to
		// be unwrapped before `holdoutComponents` can read it.
		// `openParquetRowStream` does this for its own rows.
		const candidates = flagged.getRowObjects().map((candidate) => ({
			raw: String(candidate.raw),
			source: String(candidate.source),
			source_id: String(candidate.source_id),
			country: String(candidate.country),
			span_starts: normalizeDuckDBValue(candidate.span_starts) as readonly number[] | undefined,
			span_ends: normalizeDuckDBValue(candidate.span_ends) as readonly number[] | undefined,
			span_tags: normalizeDuckDBValue(candidate.span_tags) as readonly string[] | undefined,
		}))

		if (candidates.length === CONFIRM_LIMIT) {
			console.log(
				`  ${country}: read ${CONFIRM_LIMIT.toLocaleString()} flagged rows, which is the cap rather than the total`
			)
		}

		let countryConfirmed = 0

		for (const [index, candidate] of candidates.entries()) {
			const components = holdoutComponents(candidate, index, pattern)

			if (
				splitForRow({ source_id: candidate.source_id, country: candidate.country, components }, holdouts) === "train"
			) {
				continue
			}

			countryConfirmed++

			confirmed++

			if (countryConfirmed <= shown) {
				console.log(`  ${country} ${stringifyJSON({ raw: candidate.raw, source: candidate.source, ...components })}`)
			}
		}

		console.log(
			`  ${country}: ${countryConfirmed.toLocaleString()} confirmed of ${candidates.length.toLocaleString()} flagged`
		)
	}

	console.log(
		confirmed
			? `${confirmed.toLocaleString()} held-out rows are in the ${values.split} split`
			: `no held-out row is in the ${values.split} split; every flagged row was a character-offset artifact`
	)
}
