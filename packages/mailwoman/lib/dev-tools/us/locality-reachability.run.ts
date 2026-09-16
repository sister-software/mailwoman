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

import { US_STREET_SUFFIX_LOOKUP } from "@mailwoman/codex/us/street-suffix"
import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate-schema"
import { type NameKey, normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
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

	// Keyed by name AND region: 30 states hold a Springfield, and a name-only key would collapse them into one row and
	// silently shrink the panel. Reading a 5,703-row source, that key dropped 639 rows.
	const id = `${locality}|${region}`

	if (!locality || !region || !postcode || row.lat == null || row.lon == null || byCity.has(id)) continue

	byCity.set(id, { locality, region, postcode, lat: row.lat, lon: row.lon })
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
		.where("name_key", "=", key)
		.where("placetype_id", "=", LOCALITY_PLACETYPE_ID)
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
async function carriesKey(sprID: number, key: NameKey): Promise<boolean> {
	const row = await db
		.selectFrom("candidate")
		.select("spr_id")
		.where("spr_id", "=", sprID)
		.where("name_key", "=", key)
		.executeTakeFirst()

	return row !== undefined
}

/**
 * The city's last word, when that word is a USPS suffix — the collision #2308 measures, carried on each outcome so a
 * verdict can be read against it rather than joined by hand afterwards.
 */
function suffixTail(locality: string): string | undefined {
	const last = locality
		.trim()
		.split(/\s+/)
		.at(-1)
		?.toLowerCase()
		.replaceAll(/[^a-z]/g, "")

	return last && US_STREET_SUFFIX_LOOKUP.has(last) ? last : undefined
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
	suffixTail: string | null
	words: number
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

	outcomes.push({
		city: city.locality,
		input,
		askedValue,
		askedKey,
		goldID,
		answered,
		verdict,
		suffixTail: suffixTail(city.locality) ?? null,
		words: city.locality.trim().split(/\s+/).length,
	})
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

const shapes = [
	["ends in a suffix word", outcomes.filter((row) => row.suffixTail !== null)],
	["other multi-word", outcomes.filter((row) => row.suffixTail === null && row.words > 1)],
	["single word", outcomes.filter((row) => row.suffixTail === null && row.words === 1)],
] as const

console.log(`\nby name shape:\n\n| shape | rows | matched | not_asked | unreachable | mis-ranked |`)
console.log(`| --- | --: | --: | --: | --: | --: |`)

for (const [name, bucket] of shapes) {
	const count = (verdict: Verdict) => bucket.filter((row) => row.verdict === verdict).length

	console.log(
		`| ${name} | ${bucket.length} | ${formatPercent(count("matched"), bucket.length)} |` +
			` ${count("not_asked")} | ${count("unreachable")} | ${count("reachable_not_picked")} |`
	)
}

/**
 * Rows below this are not reported per word: a rate over fewer cities than this reads the draw rather than the word,
 * and the 581-row panel this replaced had 24 of its 34 tail words at one or two rows.
 */
const MIN_ROWS_PER_WORD = 10

const byWord = new Map<string, typeof outcomes>()

for (const row of outcomes) {
	if (row.suffixTail === null) continue

	const bucket = byWord.get(row.suffixTail) ?? []

	bucket.push(row)
	byWord.set(row.suffixTail, bucket)
}

const readable = [...byWord].filter(([, wordRows]) => wordRows.length >= MIN_ROWS_PER_WORD)

console.log(
	`\nper tail word, ${readable.length} words with >= ${MIN_ROWS_PER_WORD} rows` +
		` (${byWord.size - readable.length} words below that are omitted, not zero):\n`
)
console.log(`| word | rows | matched | not_asked | unreachable |`)
console.log(`| --- | --: | --: | --: | --: |`)

for (const [word, wordRows] of readable.toSorted(
	(a, b) =>
		a[1].filter((row) => row.verdict === "matched").length / a[1].length -
		b[1].filter((row) => row.verdict === "matched").length / b[1].length
)) {
	const count = (verdict: Verdict) => wordRows.filter((row) => row.verdict === verdict).length

	console.log(
		`| ${word} | ${wordRows.length} | ${formatPercent(count("matched"), wordRows.length)} |` +
			` ${count("not_asked")} | ${count("unreachable")} |`
	)
}

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
