/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Can the gazetteer answer the key the decode asked with? (#2309)
 *
 *   A locality miss has two causes that a rate cannot tell apart. RANKING: the right place is in the candidate set and
 *   something else outranked it. REACHABILITY: the right place carries no row under that key, so no ranking could have
 *   reached it at any position. The fixes are opposite — one is a weight, the other is data — and every board rate in
 *   this repository pools them.
 *
 *   `La Grange, IL 60525` is the reachability case. The decode labels `La` a street and asks the backend for `Grange`;
 *   WOF `85940805` (population 15,667) carries 19 `name_key` rows and none of them is bare `grange`, so the three rows
 *   that come back are score-0 rural places and the pick among them is arbitrary. Re-weighting changes nothing there.
 *
 *   So this asks, per panel row: the key the RESOLVER was sent (`ResolveNodeTrace.value`, not the input and not the
 *   parse), and whether the gold place carries that key. The gold place is identified by its own name and the panel's
 *   coordinate, never by what the run answered — reading the answer back would make every row reachable by
 *   construction.
 *
 *   Usage:
 *
 *       node packages/mailwoman/lib/dev-tools/us/locality-reachability.run.ts
 *       node packages/mailwoman/lib/dev-tools/us/locality-reachability.run.ts --weights-cache <dir> --out-json <path>
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate-schema"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql } from "kysely"
import { JSONSpliterator } from "spliterator"

import { buildGauntletDeps } from "#eval-harness/gauntlet/harness"

const { values } = parseArguments({
	options: {
		"out-json": { type: "string" },
		"weights-cache": { type: "string" },
		"candidate-db": { type: "string", default: String(dataRootPath("wof", "candidate.db")) },
		eval: { type: "string", default: String(dataRootPath("eval", "coord", "us.jsonl")) },
		limit: { type: "string" },
	},
})

interface CoordRow {
	input: string
	lat?: number
	lon?: number
	expected?: { locality?: string; region?: string; postcode?: string }
}

interface PanelCity {
	locality: string
	region: string
	postcode: string
	lat: number
	lon: number
}

/**
 * How a row's locality lookup ended, in the two-cause vocabulary this probe exists to separate.
 *
 * `not_asked` is its own class rather than a miss: the decode emitted no locality span, so the backend was never given
 * a chance to answer and neither cause applies.
 */
type Verdict = "matched" | "reachable_not_picked" | "unreachable" | "not_asked" | "gold_not_found"

const rows = await Array.fromAsync(JSONSpliterator.fromAsync<CoordRow>(values.eval!))
const byCity = new Map<string, PanelCity>()

for (const row of rows) {
	const locality = row.expected?.locality?.trim()
	const region = row.expected?.region?.trim()
	const postcode = row.expected?.postcode?.trim()

	if (!locality || !region || !postcode || row.lat == null || row.lon == null || byCity.has(locality)) continue

	byCity.set(locality, { locality, region, postcode, lat: row.lat, lon: row.lon })
}

const panel = values.limit ? [...byCity.values()].slice(0, Number(values.limit)) : [...byCity.values()]

using db = new DatabaseClient<CandidateDatabase>(values["candidate-db"]!)

/**
 * How far a candidate row may sit from the panel's own coordinate and still be that row's gold place.
 *
 * Wide enough for a centroid-vs-rooftop offset on a large city, narrow enough to refuse a namesake in the next state —
 * 21 US localities are named Ramsey, and the panel coordinate is the only thing that says which one a row means. A city
 * the panel cannot identify within it is reported as `gold_not_found` rather than folded into a miss, because "we could
 * not name the right answer" and "the run named the wrong one" are different findings.
 */
const GOLD_MAX_KM = 25

/**
 * The `placetype_id` of `locality` in the candidate artifact's `placetype_codes` table.
 */
const LOCALITY_PLACETYPE_ID = 3

/**
 * The gold place for one panel city: the US locality row whose key is the city's own name and whose coordinate is
 * nearest the panel's.
 *
 * Nearest-by-coordinate rather than highest-population, because the panel row IS the disambiguation — 21 US localities
 * are named Ramsey, and the one this row means is the one at its coordinate.
 */
async function goldPlace(city: PanelCity): Promise<number | null> {
	const key = normalizeLocalityForKey(city.locality)

	if (!key) return null

	const candidates = await db
		.selectFrom("candidate")
		.select(["spr_id", "latitude", "longitude"])
		.where("name_key", "=", sql.lit(key))
		.where("placetype_id", "=", sql.lit(LOCALITY_PLACETYPE_ID))
		.execute()

	let best: { id: number; km: number } | null = null

	for (const row of candidates) {
		if (row.latitude == null || row.longitude == null) continue

		const km = haversineKm(city.lat, city.lon, row.latitude, row.longitude)

		if (!best || km < best.km) {
			best = { id: Number(row.spr_id), km }
		}
	}

	return best && best.km <= GOLD_MAX_KM ? best.id : null
}

/**
 * Whether `sprID` carries a row under `key` — the reachability question, asked of the artifact the run probed.
 */
async function carriesKey(sprID: number, key: string): Promise<boolean> {
	const row = await db
		.selectFrom("candidate")
		.select("spr_id")
		.where("spr_id", "=", sql.lit(sprID))
		.where("name_key", "=", sql.lit(key))
		.executeTakeFirst()

	return row !== undefined
}

const deps = await buildGauntletDeps(values["weights-cache"] ? { weightsCacheRoot: values["weights-cache"] } : {})

const outcomes: Array<{
	city: string
	input: string
	askedValue: string | null
	askedKey: string | null
	goldID: number | null
	answered: string | null
	verdict: Verdict
}> = []

for (const city of panel) {
	const input = `${city.locality}, ${city.region} ${city.postcode}`
	const { result, resolver } = await deps.geocodeTraced(input, { defaultCountry: "US" })
	const lookup = resolver.find((record) => record.tag === "locality")
	const answered = result.locality ?? null
	const goldID = await goldPlace(city)

	const askedValue = lookup?.value ?? null
	const askedKey = askedValue ? normalizeLocalityForKey(askedValue) : null

	let verdict: Verdict

	if (answered === city.locality) {
		verdict = "matched"
	} else if (!lookup) {
		verdict = "not_asked"
	} else if (goldID === null) {
		verdict = "gold_not_found"
	} else if (askedKey && (await carriesKey(goldID, askedKey))) {
		verdict = "reachable_not_picked"
	} else {
		verdict = "unreachable"
	}

	outcomes.push({ city: city.locality, input, askedValue, askedKey, goldID, answered, verdict })
}

const tally = new Map<Verdict, number>()

for (const row of outcomes) {
	tally.set(row.verdict, (tally.get(row.verdict) ?? 0) + 1)
}

console.log(`#2309 locality reachability — ${panel.length} distinct US cities, bare \`«city», «ST» «ZIP»\` arm\n`)
console.log(`| verdict | rows | share |`)
console.log(`| --- | --: | --: |`)

for (const verdict of ["matched", "reachable_not_picked", "unreachable", "not_asked", "gold_not_found"] as const) {
	const n = tally.get(verdict) ?? 0

	console.log(`| ${verdict} | ${n} | ${formatPercent(n, panel.length)} |`)
}

const missed = outcomes.filter((row) => row.verdict !== "matched")

console.log(
	`\nOf the ${missed.length} non-matching rows: ${tally.get("unreachable") ?? 0} could not be reached at any rank,` +
		` ${tally.get("reachable_not_picked") ?? 0} were reachable and lost the ranking, and` +
		` ${tally.get("not_asked") ?? 0} never produced a locality span for the backend to answer.`
)

for (const row of missed.filter((r) => r.verdict === "unreachable").slice(0, 12)) {
	console.log(`  UNREACHABLE ${row.input} → asked ${stringifyJSON(row.askedKey)}, gold ${row.goldID} lacks that key`)
}

for (const row of missed.filter((r) => r.verdict === "reachable_not_picked").slice(0, 12)) {
	console.log(
		`  MIS-RANKED  ${row.input} → asked ${stringifyJSON(row.askedKey)}, answered ${stringifyJSON(row.answered)}`
	)
}

if (values["out-json"]) {
	await writeLocalJSONFile({ panel: panel.length, rows: outcomes }, values["out-json"])

	console.log(`\nwrote ${values["out-json"]}`)
}
