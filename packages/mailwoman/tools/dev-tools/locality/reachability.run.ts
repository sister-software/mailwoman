/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A locality miss has two causes that a rate cannot distinguish.
 *   A ranking miss means the right place is in the candidate set but was outranked.
 *   Reachability means the right place has no row
 *   under the asked key so no ranking could have reached it at any position.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate/schema"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { type NameKey, normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { type PanelLocality, readCoordPanel, renderAdmin, suffixTail } from "#tools/dev-tools/coord-panel"
import { buildGauntletDeps } from "#tools/eval-harness/gauntlet/harness"

const { values } = parseArguments({
	options: {
		"out-json": { type: "string" },
		"weights-cache": { type: "string" },
		"candidate-db": { type: "string", default: wofDatabasePath("candidate.db").toString() },
		eval: { type: "string", default: dataRootPath("eval", "coord", "us.jsonl").toString() },
		// The country a panel row belongs to when the panel has no country per row.
		// It selects the codex layout the row is written through before it is a scope decision.
		country: { type: "string", default: "US" },
		limit: { type: "string" },
	},
})

/**
 * `not_asked` is its own class rather than a miss: the decode emitted no locality span,
 * so the backend was never given a chance to answer and neither cause applies.
 */
type Verdict = "matched" | "reachable_not_picked" | "unreachable" | "not_asked" | "gold_not_found"

const { localities: panel, qualifiersStripped } = await readCoordPanel(values.eval!, {
	country: values.country,
	...(values.limit ? { limit: Number(values.limit) } : {}),
})

using db = new DatabaseClient<CandidateDatabase>(values["candidate-db"]!)

/**
 * How far a candidate row may sit from the panel's own coordinate and still be that
 * row's gold place: wide enough for a centroid-vs-rooftop offset, narrow enough to
 * refuse a namesake one region over, with a place the panel cannot identify within
 * it reported as `gold_not_found` rather than folded into a miss.
 */
const GOLD_MAX_KM = 25

/**
 * The `placetype_id` of `locality` in the candidate artifact's `placetype_codes` table.
 */
const LOCALITY_PLACETYPE_ID = 3

/**
 * The gold place for one panel row: the locality whose key is the row's own name
 * and whose coordinate is nearest the panel's, chosen by coordinate rather than population
 * because the panel row is the disambiguation.
 */
async function goldPlace(place: PanelLocality): Promise<number | null> {
	const key = normalizeLocalityForKey(place.locality)

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

		const km = haversineKm(place.lat, place.lon, row.latitude, row.longitude)

		if (!best || km < best.km) {
			best = { id: Number(row.spr_id), km }
		}
	}

	return best && best.km <= GOLD_MAX_KM ? best.id : null
}

async function carriesKey(sprID: number, key: NameKey): Promise<boolean> {
	const row = await db
		.selectFrom("candidate")
		.select("spr_id")
		.where("spr_id", "=", sprID)
		.where("name_key", "=", key)
		.executeTakeFirst()

	return row !== undefined
}

const deps = await buildGauntletDeps(values["weights-cache"] ? { weightsCacheRoot: values["weights-cache"] } : {})

/**
 * Rows whose country has no layout able to write them, counted and reported
 * rather than dropped so the rates below keep their denominator.
 */
let unrenderable = 0

const results: Array<{
	locality: string
	country: string
	region: string
	input: string
	askedValue: string | null
	askedKey: string | null
	goldID: number | null
	answered: string | null
	verdict: Verdict
	suffixTail: string | null
	words: number
}> = []

for (const place of panel) {
	const input = renderAdmin(place)

	// A country whose layout writes no line answers "" rather than an invented order.
	// Report the row as its own class instead of grading it as a miss.
	if (!input) {
		unrenderable++

		continue
	}

	const { result, resolver } = await deps.geocodeTraced(input, { defaultCountry: place.country })
	const lookup = resolver.find((record) => record.tag === "locality")
	const answered = result.locality ?? null
	const goldID = await goldPlace(place)

	const askedValue = lookup?.value ?? null
	const askedKey = askedValue ? normalizeLocalityForKey(askedValue) : null

	let verdict: Verdict

	if (answered === place.locality) {
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

	results.push({
		locality: place.locality,
		country: place.country,
		region: place.region,
		input,
		askedValue,
		askedKey,
		goldID,
		answered,
		verdict,
		suffixTail: suffixTail(place.locality) ?? null,
		words: place.locality.trim().split(/\s+/).length,
	})
}

const countriesSeen = new Set(panel.map((place) => place.country))
const tally = new Map<Verdict, number>()

for (const row of results) {
	tally.set(row.verdict, (tally.get(row.verdict) ?? 0) + 1)
}

console.log(
	`#2309 locality reachability — ${results.length} localities in ${countriesSeen.size} country/countries` +
		` (${[...countriesSeen].toSorted().join(", ")}), bare admin arm written through each country's codex layout` +
		(qualifiersStripped
			? `\n${qualifiersStripped} expected string(s) carried a trailing parenthetical qualifier, stripped before grading.`
			: "") +
		(unrenderable ? `\n${unrenderable} row(s) belong to a country whose layout writes nothing; not graded.` : "") +
		"\n"
)
console.log(`| verdict | rows | share |`)
console.log(`| --- | --: | --: |`)

for (const verdict of ["matched", "reachable_not_picked", "unreachable", "not_asked", "gold_not_found"] as const) {
	const n = tally.get(verdict) ?? 0

	// Denominated on graded rows rather than on the panel: an unrenderable row was never asked.
	console.log(`| ${verdict} | ${n} | ${formatPercent(n, results.length)} |`)
}

const missed = results.filter((row) => row.verdict !== "matched")

console.log(
	`\nOf the ${missed.length} non-matching rows: ${tally.get("unreachable") ?? 0} could not be reached at any rank,` +
		` ${tally.get("reachable_not_picked") ?? 0} were reachable and lost the ranking, and` +
		` ${tally.get("not_asked") ?? 0} never produced a locality span for the backend to answer.`
)

const shapes = [
	["ends in a suffix word", results.filter((row) => row.suffixTail !== null)],
	["other multi-word", results.filter((row) => row.suffixTail === null && row.words > 1)],
	["single word", results.filter((row) => row.suffixTail === null && row.words === 1)],
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
 * Below this many rows a word is not reported per word: a rate over fewer places
 * reads the draw rather than the word.
 */
const MIN_ROWS_PER_WORD = 10

const byWord = new Map<string, typeof results>()

for (const row of results) {
	if (!row.suffixTail) continue

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
	await writeLocalJSONFile(
		{
			panel: panel.length,
			graded: results.length,
			unrenderable,
			countries: [...countriesSeen].toSorted(),
			rows: results,
		},
		values["out-json"]
	)

	console.log(`\nwrote ${values["out-json"]}`)
}
