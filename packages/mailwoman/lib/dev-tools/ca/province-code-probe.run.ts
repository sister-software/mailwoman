/**
 * All thirteen Canadian province and territory codes, in the shape #2299 fails on,
 * through the production path.
 *
 * `Swiss Chalet, 92 Laurel Rd, Gander, NL A1V 0A9, Canada` answers `country: "NL"` —
 * the Netherlands — with `Canada` written in full at the end of the same string.
 * Several province codes collide with an ISO alpha-2 country code, and a code left unattested
 * by the corpus is not merely missing: the model reads it as the country it does know.
 *
 * Two arms per province, because `NL` and `PE` fail under different conditions and one arm cannot show it.
 * `NL` contradicts the country with or without a postal code; `PE` needs the postal code,
 * and then takes the locality slot rather than the country's, destroying the city.
 *
 * A probe that rendered only one shape would report one of them as passing.
 *
 * The postal codes are real, read from `postalcode-ca-overture.db`, and each is the one nearest its seat.
 * The distance rides in the output so a reader can see the city and the code name the same town.
 *
 * Selecting the province's busiest code instead paired `Winnipeg` with `R0C 2Z0`,
 * which is Stonewall, 30 km away.
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
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql } from "kysely"

import { buildGauntletDeps } from "#eval-harness/gauntlet/harness"

const { values } = parseArguments({
	options: {
		"out-json": { type: "string" },
		"weights-cache": { type: "string" },
		"postcode-db": { type: "string", default: String(dataRootPath("db", "wof", "postalcode-ca-overture.db")) },
	},
})

/**
 * One locality per province, with a real postal code from it.
 *
 * The locality is the province's own seat rather than a name read from the postcode artifact:
 * that artifact carries the code and its point, and no name a query could be written with.
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
 * The first letter of a Canadian postal code names its province, which is what lets
 * a real code be found per province without a name join.
 *
 * Newfoundland is `A`, Nova Scotia `B`, and so on.
 * The three that share a letter with a neighbour are separated by the second character,
 * which this does not need — any code in the province serves.
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
	 * How far the chosen code's point sits from the seat, on the rows that carry one.
	 *
	 * Reported because the pairing is the probe's own construction: a row whose city
	 * and code name different towns grades a contradiction the model never had to answer,
	 * and a reader cannot tell one from a real failure without this number.
	 */
	postcodeKm: number | null
	country: string | null
	region: string | null
	locality: string | null
	correct: boolean
}

using db = new DatabaseClient<WOFDatabase>(values["postcode-db"]!)

/**
 * The postal code nearest the seat, spaced the way an address writes it, with the distance it sits at.
 *
 * Nearest rather than busiest, and the distance is reported rather than assumed.
 * Ranking a province's codes by address-point count selects a rural code every time:
 * a rural code spans a whole district and holds thousands of points, while a
 * downtown code covers one block and holds single digits.
 *
 * Manitoba's twelve busiest are all `R0x`, and the busiest of them, `R0C 2Z0` at 2,381 points,
 * is Stonewall — 30 km from Winnipeg, which is the seat it was being paired with.
 * `Winnipeg, MB R0C 2Z0` is then an address whose city and postal code name different towns,
 * and a model that declines to commit on it is behaving correctly while the probe records a failure.
 *
 * The seat's own coordinate comes from the no-postcode arm this probe already runs,
 * so nothing here needs a second gazetteer and the pairing is checkable from the output.
 */
async function postcodeNearest(code: string, seat: { lat: number; lon: number }): Promise<PostcodePick | null> {
	let best: PostcodePick | null = null

	for (const prefix of POSTAL_PREFIXES[code] ?? []) {
		const rows = await sql<{
			name: string
			latitude: number
			longitude: number
			// glob the full A1A1A1 shape rather than counting characters.
			// The artifact stores some names with their space already in, so a length test admits
			// `Y1A R6` — five significant characters — and spacing it again writes `Y1A  R6`,
			// an address no Canadian writes and no model should be asked to read.
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

/**
 * A chosen code and how far its point sits from the seat it is paired with.
 */
interface PostcodePick {
	postcode: string
	km: number
}

// A probe written to price a corpus change has to be able to point at the model that change produced.
// Without this it can only ever grade the installed one, which is the arm the change is measured against.
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

		// The row is correct when the country is Canada and the region is the code and the locality survived.
		// A country answered as the province's own code is the contradiction.
		// A locality answered as the code is the other failure.
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
 * The province codes that are also an ISO 3166-1 alpha-2 country code, derived rather than listed.
 *
 * A list here would be a second copy of a table the platform already holds,
 * and the copy is what goes stale: the five below are `NL`, `NU`, `PE`, `SK`
 * and `YT`, where the issue that opened this named two.
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
