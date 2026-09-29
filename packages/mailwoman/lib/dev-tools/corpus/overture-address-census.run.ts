/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Counts address rows per country in an Overture release. It reports how many rows have a street,
 *   a house number and a postcode.
 *
 *   This answers which jurisdictions a corpus build could admit from a permissively licensed bulk source.
 *   `OVERTURE_DEFAULT_LICENSE` is `CDLA-Permissive-2.0`, attribution-only, so a row from this source
 *   reaches a build without a share-alike obligation. The source register's 389 entries do not affect
 *   this result. The release is already on disk under the data root.
 *
 *   A country whose file omits one of the projected columns is reported with the missing column specified rather than
 *   counted as zero, because a release that renames a column would otherwise read as a country with no
 *   streets.
 *
 *   `COUNT(DISTINCT …)` is deliberately absent. A distinct count over a corpus of this size exhausted the
 *   host twice on 2026-09-28. Row counts answer the admission question.
 *
 *   Usage:
 *   node packages/mailwoman/lib/dev-tools/corpus/overture-address-census.run.ts \
 *     [--release 2026-06-17.0] [--min-street-rows 50000] [--json <out>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { Globerator } from "spliterator/node/fs"

/**
 * The columns a jurisdiction needs for an address row to teach a street grammar.
 */
const PROJECTED_COLUMNS = ["street", "number", "postcode"] as const

interface CountryCensus {
	country: string
	file: string
	rows: number
	streetRows: number
	numberRows: number
	postcodeRows: number
	absentColumns: string[]
}

const { values } = parseArguments({
	options: {
		release: { type: "string", description: "Release directory under <data root>/overture (default: the newest)" },
		"min-street-rows": { type: "string", description: "Street-row floor a country must clear (default 50000)" },
		json: { type: "string", description: "Write the per-country census to this path" },
	},
})

const minStreetRows = Number(values["min-street-rows"] ?? 50_000)

if (!Number.isFinite(minStreetRows) || minStreetRows < 0) {
	throw new Error(`--min-street-rows must be a non-negative number, read ${values["min-street-rows"]}`)
}

const overtureRoot = dataRootPath("overture")

/**
 * Release directory → the `addresses-<cc>.parquet` names it holds.
 */
const byRelease = new Map<string, string[]>()

for await (const entry of Globerator.from("*/addresses-*.parquet", { cwd: overtureRoot, absolute: false })) {
	const [directory, file] = entry.split("/")

	if (!directory || !file || !/^addresses-[a-z]{2}\.parquet$/u.test(file)) continue

	byRelease.set(directory, [...(byRelease.get(directory) ?? []), file])
}

const releases = [...byRelease.keys()].toSorted()

if (!releases.length) throw new Error(`No addresses-<cc>.parquet under any release directory of ${overtureRoot}`)

const release = values.release ?? releases.at(-1)!
const files = byRelease.get(release)?.toSorted()

if (!files) {
	throw new Error(`Release ${release} holds no address file under ${overtureRoot}; found ${releases.join(", ")}`)
}

const releaseRoot = overtureRoot(release)

console.log(`release ${release}: ${files.length} country files under ${releaseRoot}`)

using db = await openDuckDB()

const census: CountryCensus[] = []

for (const file of files) {
	const country = file.slice("addresses-".length, -".parquet".length).toUpperCase()
	const path = releaseRoot(file).toString()
	const source = `read_parquet('${escapeSQLString(path)}')`

	const described = await db.runAndReadAll(`DESCRIBE SELECT * FROM ${source} LIMIT 0`)

	const present = new Set(
		(described.getRowObjectsJS() as Array<{ column_name: string }>).map((row) => String(row.column_name))
	)

	const absentColumns = PROJECTED_COLUMNS.filter((column) => !present.has(column))

	const counted = PROJECTED_COLUMNS.filter((column) => present.has(column)).map(
		(column) =>
			`count(CASE WHEN "${column}" IS NOT NULL AND length(trim("${column}")) > 0 THEN 1 END) AS ${column}_rows`
	)

	const result = await db.runAndReadAll(
		`SELECT count(*) AS rows${counted.length ? `, ${counted.join(", ")}` : ""} FROM ${source}`
	)

	const row = (result.getRowObjectsJS() as Array<Record<string, unknown>>)[0] ?? {}
	const read = (key: string): number => (key in row ? Number(row[key]) : 0)

	const entry: CountryCensus = {
		country,
		file,
		rows: read("rows"),
		streetRows: read("street_rows"),
		numberRows: read("number_rows"),
		postcodeRows: read("postcode_rows"),
		absentColumns,
	}

	census.push(entry)

	const share = entry.rows > 0 ? ((entry.streetRows / entry.rows) * 100).toFixed(1) : "0.0"

	console.log(
		`${entry.country}  ${entry.rows.toLocaleString()} rows  ${entry.streetRows.toLocaleString()} street (${share}%)` +
			`  ${entry.postcodeRows.toLocaleString()} postcode` +
			(absentColumns.length ? `  ABSENT COLUMNS: ${absentColumns.join(", ")}` : "")
	)
}

const clearing = census
	.filter((entry) => entry.streetRows >= minStreetRows)
	.toSorted((a, b) => b.streetRows - a.streetRows)

const below = census.filter((entry) => entry.streetRows < minStreetRows)

console.log(
	`\n${clearing.length} of ${census.length} countries hold at least ${minStreetRows.toLocaleString()} street rows`
)
console.log(`clearing: ${clearing.map((entry) => entry.country).join(" ")}`)
console.log(
	`below the floor: ${below.map((entry) => `${entry.country}(${entry.streetRows.toLocaleString()})`).join(" ")}`
)

const withAbsent = census.filter((entry) => entry.absentColumns.length > 0)

console.log(
	withAbsent.length
		? `countries whose file omits a projected column: ${withAbsent.map((entry) => `${entry.country}[${entry.absentColumns.join(",")}]`).join(" ")}`
		: "every country file carries street, number and postcode columns"
)

if (values.json) {
	await writeLocalJSONFile(
		{ release, minStreetRows, countries: census, clearing: clearing.map((entry) => entry.country) },
		values.json
	)

	console.log(`\nwrote ${values.json}`)
}
