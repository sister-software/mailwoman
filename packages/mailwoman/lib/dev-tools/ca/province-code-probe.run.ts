/**
 * All thirteen Canadian province and territory codes, in the shape #2299 fails on, through the production path.
 *
 * `Swiss Chalet, 92 Laurel Rd, Gander, NL A1V 0A9, Canada` answers `country: "NL"` — the Netherlands — with `Canada`
 * written in full at the end of the same string. Several province codes collide with an ISO alpha-2 country code, and a
 * code left unattested by the corpus is not merely missing: the model reads it as the country it does know.
 *
 * Two arms per province, because `NL` and `PE` fail under DIFFERENT conditions and one arm cannot show it. `NL`
 * contradicts the country with or without a postal code; `PE` needs the postal code, and then takes the LOCALITY slot
 * rather than the country's, destroying the city. A probe that rendered only one shape would report one of them as
 * passing.
 *
 * The postal codes are real, read from `postalcode-ca-overture.db` — the highest-address-point code in each province,
 * so a row that resolves is resolving somewhere a person lives.
 *
 * Run:
 *
 *     node packages/mailwoman/lib/dev-tools/ca/province-code-probe.run.ts
 *     node packages/mailwoman/lib/dev-tools/ca/province-code-probe.run.ts --out-json <path>
 */

import { CA_PROVINCES } from "@mailwoman/codex/ca"
import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql } from "kysely"

import { buildGauntletDeps } from "#eval-harness/gauntlet/harness"

const { values } = parseArguments({
	options: {
		"out-json": { type: "string" },
		"weights-cache": { type: "string" },
		"postcode-db": { type: "string", default: String(dataRootPath("wof", "postalcode-ca-overture.db")) },
	},
})

/**
 * One locality per province, with a real postal code from it.
 *
 * The locality is the province's own seat rather than a name read from the postcode artifact: that artifact carries the
 * code and its point, and no name a query could be written with.
 */
const SEATS: Readonly<Record<string, string>> = {
	AB: "Edmonton",
	BC: "Victoria",
	MB: "Winnipeg",
	NB: "Fredericton",
	NL: "St. John's",
	NS: "Halifax",
	NT: "Yellowknife",
	NU: "Iqaluit",
	ON: "Toronto",
	PE: "Charlottetown",
	QC: "Québec",
	SK: "Regina",
	YT: "Whitehorse",
}

/**
 * The first letter of a Canadian postal code names its province, which is what lets a real code be found per province
 * without a name join. Newfoundland is `A`, Nova Scotia `B`, and so on; the three that share a letter with a neighbour
 * are separated by the second character, which this does not need — any code in the province serves.
 */
const POSTAL_PREFIXES: Readonly<Record<string, readonly string[]>> = {
	AB: ["T"],
	BC: ["V"],
	MB: ["R"],
	NB: ["E"],
	NL: ["A"],
	NS: ["B"],
	NT: ["X"],
	NU: ["X"],
	ON: ["K", "L", "M", "N", "P"],
	PE: ["C"],
	QC: ["G", "H", "J"],
	SK: ["S"],
	YT: ["Y"],
}

/**
 * A Canadian postal code, unspaced as the artifact stores it — `A1V0A9`. The artifact also holds forward sortation
 * areas, which are three characters, and those name no deliverable point.
 */
const POSTAL_CODE_LENGTH = 6

interface ProbeRow {
	code: string
	province: string
	input: string
	withPostcode: boolean
	country: string | null
	region: string | null
	locality: string | null
	correct: boolean
}

using db = new DatabaseClient<WOFDatabase>(values["postcode-db"]!)

/**
 * The busiest postal code in a province, spaced the way an address writes it.
 */
async function postcodeFor(code: string): Promise<string | null> {
	for (const prefix of POSTAL_PREFIXES[code] ?? []) {
		const rows = await sql<{
			name: string
		}>`SELECT name FROM spr WHERE name LIKE ${`${prefix}%`} ORDER BY point_count DESC LIMIT 1`.execute(db)

		const name = rows.rows[0]?.name

		if (name && name.length === POSTAL_CODE_LENGTH) return `${name.slice(0, 3)} ${name.slice(3)}`
	}

	return null
}

// A probe written to price a corpus change has to be able to point at the model that change produced; without this it
// can only ever grade the installed one, which is the arm the change is measured AGAINST.
const deps = await buildGauntletDeps(values["weights-cache"] ? { weightsCacheRoot: values["weights-cache"] } : {})
const report: ProbeRow[] = []

for (const { code, name } of Object.values(CA_PROVINCES)) {
	const locality = SEATS[code]

	if (!locality) continue

	const postcode = await postcodeFor(code)

	for (const withPostcode of [false, true]) {
		if (withPostcode && !postcode) continue

		const input = withPostcode ? `${locality}, ${code} ${postcode}, Canada` : `${locality}, ${code}, Canada`
		const result = await deps.geocode(input, {})

		// The row is correct when the country is Canada AND the region is the code AND the locality survived. A country
		// answered as the province's own code is the contradiction; a locality answered as the code is the other failure.
		report.push({
			code,
			province: name,
			input,
			withPostcode,
			country: result.countryCode ?? null,
			region: result.region ?? null,
			locality: result.locality ?? null,
			correct: result.countryCode === "CA" && result.region === code && result.locality === locality,
		})
	}
}

const correct = report.filter((row) => row.correct)

/**
 * The province codes that are also an ISO 3166-1 alpha-2 country code, DERIVED rather than listed.
 *
 * A list here would be a second copy of a table the platform already holds, and the copy is what goes stale: the five
 * below are `NL`, `NU`, `PE`, `SK` and `YT`, where the issue that opened this named two.
 */
const regionNames = new Intl.DisplayNames(["en"], { type: "region" })

const collisions = Object.values(CA_PROVINCES)
	.map(({ code }) => {
		const country = regionNames.of(code)

		return country && country !== code ? `${code} (${country})` : null
	})
	.filter((entry): entry is string => entry !== null)

console.log(`#2299 province-code probe — ${report.length} rows over ${Object.keys(SEATS).length} provinces`)
console.log(`codes that are also a country: ${collisions.join(", ")}\n`)
console.log(`| code | postcode | country | region | locality |`)
console.log(`| --- | --- | --- | --- | --- |`)

for (const row of report) {
	const mark = row.correct ? "" : "  ←"
	const shape = row.withPostcode ? "yes" : "no"

	console.log(
		`| ${row.code} | ${shape} | ${row.country ?? "—"} | ${row.region ?? "—"} | ${row.locality ?? "—"} |${mark}`
	)
}

console.log(`\n${correct.length}/${report.length} correct.`)

for (const row of report.filter((entry) => !entry.correct)) {
	console.log(`  ${row.input}`)
}

if (values["out-json"]) {
	await writeLocalJSONFile({ rows: report, correct: correct.length, total: report.length }, values["out-json"])

	console.log(`\nwrote ${values["out-json"]}`)
}
