/**
 * All thirteen Canadian province and territory codes, through the production path:
 * several collide with an ISO alpha-2 country code, and a code left unattested
 * by the corpus is read as the country it spells.
 *
 * Two arms per province, because `NL` contradicts the country with or without a postal code
 * while `PE` takes the locality slot once one is present.
 *
 * Each postal code is real and nearest its seat, and the distance is reported
 * so a reader can see the city and code name the same town.
 *
 * Run:
 *
 *     node packages/mailwoman/lib/dev-tools/ca/province-code-probe.run.ts
 *     node packages/mailwoman/lib/dev-tools/ca/province-code-probe.run.ts --out-json <path>
 */

import { CA_PROVINCES } from "@mailwoman/codex/ca"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql } from "kysely"

import { buildGauntletDeps } from "#eval-harness/gauntlet/harness"

const { values } = parseArguments({
	options: {
		"out-json": { type: "string" },
		"weights-cache": { type: "string" },
		"postcode-db": { type: "string", default: wofDatabasePath("postalcode-ca-overture.db").toString() },
	},
})

/**
 * One locality per province, the province's own seat rather than a name read from the postcode
 * artifact, which carries the code and its point but no name a query could be written with.
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
 * The first letter of a Canadian postal code names its province, which lets a real
 * code be found per province without a name join.
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

interface ProbeRow {
	code: string
	province: string
	input: string
	withPostcode: boolean
	/**
	 * How far the chosen code's point sits from the seat, because a row whose city and code
	 * name different towns would otherwise grade a contradiction the model never had to answer.
	 */
	postcodeKm: number | null
	country: string | null
	region: string | null
	locality: string | null
	correct: boolean
}

using db = new DatabaseClient<WOFDatabase>(values["postcode-db"]!)

/**
 * The postal code nearest the seat, spaced the way an address writes it, with the distance it sits at:
 * ranking a province's codes by address-point count selects a rural code that spans a whole district.
 */
async function postcodeNearest(code: string, seat: { lat: number; lon: number }): Promise<PostcodePick | null> {
	let best: PostcodePick | null = null

	for (const prefix of POSTAL_PREFIXES[code] ?? []) {
		const rows = await sql<{
			name: string
			latitude: number
			longitude: number
			// Glob the full A1A1A1 shape rather than counting characters, because the artifact
			// stores some names with their space already in and a length test would admit `Y1A R6`.
		}>`SELECT name, latitude, longitude FROM spr WHERE name LIKE ${`${prefix}%`} AND name GLOB ${"[A-Z][0-9][A-Z][0-9][A-Z][0-9]"}`.execute(
			db
		)

		for (const row of rows.rows) {
			const km = haversineKm(seat.lat, seat.lon, row.latitude, row.longitude)

			if (!best || km < best.km) {
				best = { postcode: `${row.name.slice(0, 3)} ${row.name.slice(3)}`, km }
			}
		}
	}

	return best
}

interface PostcodePick {
	postcode: string
	km: number
}

// Without `--weights-cache` this can only grade the installed model, which is the arm the change is measured against.
const deps = await buildGauntletDeps(values["weights-cache"] ? { weightsCacheRoot: values["weights-cache"] } : {})
const report: ProbeRow[] = []

for (const { code, name } of Object.values(CA_PROVINCES)) {
	const locality = SEATS[code]

	if (!locality) continue

	// The bare arm runs first because its coordinate is what makes the postcode arm's pairing coherent.
	const seatResult = await deps.geocode(`${locality}, ${code}, Canada`, {})

	const pick =
		typeof seatResult.lat === "number" && typeof seatResult.lon === "number"
			? await postcodeNearest(code, { lat: seatResult.lat, lon: seatResult.lon })
			: null

	for (const withPostcode of [false, true]) {
		if (withPostcode && !pick) continue

		const input = withPostcode ? `${locality}, ${code} ${pick!.postcode}, Canada` : `${locality}, ${code}, Canada`
		const result = withPostcode ? await deps.geocode(input, {}) : seatResult

		report.push({
			code,
			province: name,
			input,
			withPostcode,
			postcodeKm: withPostcode ? pick!.km : null,
			country: result.countryCode ?? null,
			region: result.region ?? null,
			locality: result.locality ?? null,
			correct: result.countryCode === "CA" && result.region === code && result.locality === locality,
		})
	}
}

const correct = report.filter((row) => row.correct)

/**
 * The province codes that are also an ISO 3166-1 alpha-2 country code, derived
 * rather than listed so the table cannot go stale.
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
console.log(`| code | code↔seat | country | region | locality |`)
console.log(`| --- | --- | --- | --- | --- |`)

for (const row of report) {
	const mark = row.correct ? "" : "  ←"
	const shape = row.withPostcode ? `${row.postcodeKm!.toFixed(1)} km` : "no"

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
