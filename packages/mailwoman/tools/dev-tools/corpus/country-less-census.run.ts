/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Asks the gazetteer which non-ISO country rows in a corpus file it can attribute to a country.
 *   Reports how many rows remain unattributed.
 *
 *   `v0.6.0-register-surface` contains 4,765 rows whose `country` reads `ZZ`, the ISO 3166-1 user-assigned
 *   range rather than a country, every one with `locale: und` and `source: synth-fragment`. The recipe that
 *   wrote them is no longer in the tree, so the rows cannot be rebuilt with countries attached.
 *   The options are to attribute them, declare them, or drop them at the next base rebuild.
 *   Each option requires the count the gazetteer can settle.
 *
 *   The gazetteer is asked through `WOFCandidateTableLookup.findPlace`, the reader the resolver itself
 *   calls, so a row this reports as unattributable is one the request path would also fail to place. A row
 *   whose name resolves to more than one country is reported as ambiguous rather than attributed, because
 *   picking the first would stamp a country the evidence does not settle.
 *
 *   Usage:
 *   node packages/mailwoman/tools/dev-tools/corpus/country-less-census.run.ts \
 *     --parquet /mnt/mw/corpus/versioned/v0.6.0-overlay-staging/part-fragment.migrated.train.parquet \
 *     [--country ZZ] [--candidate-db <path>] [--json <out>]
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { WOFCandidateTableLookup } from "@mailwoman/resolver-wof-sqlite/candidate/lookup"

import { resolveCandidateDBPath } from "#resolver-backend"

const { values } = parseArguments({
	options: {
		parquet: { type: "string", description: "The parquet file to census" },
		country: { type: "string", description: "The country code to attribute (default ZZ)" },
		"candidate-db": { type: "string", description: "Candidate gazetteer path" },
		json: { type: "string", description: "Write the per-row verdicts to this path" },
	},
})

if (!values.parquet) throw new Error("--parquet is required")

const country = values.country ?? "ZZ"
const candidateDB = await resolveCandidateDBPath(values["candidate-db"])

if (!candidateDB) {
	throw new Error(
		"No candidate gazetteer resolved. Pass --candidate-db, or set $MAILWOMAN_CANDIDATE_DB. Without it every " +
			"row would read as unplaced, which is indistinguishable from a real absence."
	)
}

/**
 * What the gazetteer settled for one row.
 */
interface Verdict {
	raw: string
	rows: number
	countries: string[]
	/**
	 * `attributed` where exactly one country answered, `ambiguous` where several did, `unplaced` where none.
	 */
	state: "attributed" | "ambiguous" | "unplaced"
}

using db = await openDuckDB()

const grouped = await db.runAndReadAll(
	`SELECT raw, COUNT(*) AS rows FROM read_parquet('${values.parquet.replaceAll("'", "''")}') ` +
		`WHERE country = '${country.replaceAll("'", "''")}' GROUP BY raw ORDER BY raw`
)

const names = grouped.getRowObjectsJS() as Array<{ raw: string; rows: bigint }>
const totalRows = names.reduce((sum, row) => sum + Number(row.rows), 0)

console.log(`${values.parquet}`)
console.log(
	`  country ${country}: ${totalRows.toLocaleString()} rows over ${names.length.toLocaleString()} distinct raw values`
)
console.log(`  gazetteer: ${candidateDB}`)

using lookup = new WOFCandidateTableLookup({ databasePath: candidateDB })

const verdicts: Verdict[] = []

for (const [index, row] of names.entries()) {
	const places = await lookup.findPlace({ text: row.raw })

	const countries = [
		...new Set(places.map((place) => place.country).filter((value): value is string => Boolean(value))),
	]

	verdicts.push({
		raw: row.raw,
		rows: Number(row.rows),
		countries: countries.toSorted(),
		state: countries.length === 1 ? "attributed" : countries.length > 1 ? "ambiguous" : "unplaced",
	})

	if ((index + 1) % 500 === 0) {
		console.error(`    ${index + 1} of ${names.length} names…`)
	}
}

const tally = (state: Verdict["state"]) => {
	const matching = verdicts.filter((verdict) => verdict.state === state)

	return { names: matching.length, rows: matching.reduce((sum, verdict) => sum + verdict.rows, 0) }
}

const attributed = tally("attributed")
const ambiguous = tally("ambiguous")
const unplaced = tally("unplaced")

console.log(
	`\n  attributed to exactly one country  ${attributed.rows.toLocaleString()} rows, ${attributed.names.toLocaleString()} names`
)
console.log(
	`  resolved to several countries       ${ambiguous.rows.toLocaleString()} rows, ${ambiguous.names.toLocaleString()} names`
)
console.log(
	`  the gazetteer cannot place          ${unplaced.rows.toLocaleString()} rows, ${unplaced.names.toLocaleString()} names`
)

if (attributed.rows + ambiguous.rows + unplaced.rows !== totalRows) {
	throw new Error(`census: the three verdict classes sum to a different row count than the ${totalRows} read`)
}

const byCountry = new Map<string, number>()

for (const verdict of verdicts) {
	if (verdict.state !== "attributed") continue

	const [only] = verdict.countries

	byCountry.set(only!, (byCountry.get(only!) ?? 0) + verdict.rows)
}

console.log(`\n  attributed rows by country, most first:`)

for (const [code, rows] of [...byCountry.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 20)) {
	console.log(`    ${code}  ${rows.toLocaleString()}`)
}

console.log(`\n  ten names the gazetteer cannot place:`)

for (const verdict of verdicts.filter((entry) => entry.state === "unplaced").slice(0, 10)) {
	console.log(`    ${verdict.raw}  (${verdict.rows} rows)`)
}

if (values.json) {
	await writeLocalJSONFile({ parquet: values.parquet, country, candidateDB, totalRows, verdicts }, values.json)

	console.log(`\n  wrote ${values.json}`)
}
