/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Can the gazetteer answer the key the decode asked with? (#2309)
 *
 *   A locality miss has two causes that a rate cannot tell apart. ranking: the right place is in the candidate set and
 *   something else outranked it. reachability: the right place carries no row under that key, so no ranking could have
 *   reached it at any position. The fixes are opposite — one is a weight, the other is data — and every board rate in
 *   this repository pools them.
 *
 *   `La Grange, IL 60525` is the reachability case. The decode labels `La` a street and asks the backend for `Grange`;
 *   WOF `85940805` (population 15,667) carries 19 `name_key` rows and none of them is bare `grange`, so the three rows
 *   that come back are score-0 rural places and the pick among them is arbitrary. Re-weighting changes nothing there.
 *
 *   So this asks, per panel row: the key the resolver was sent (`ResolveNodeTrace.value`, not the input and not the
 *   parse), and whether the gold place carries that key. The gold place is identified by its own name and the panel's
 *   coordinate, never by what the run answered — reading the answer back would make every row reachable by
 *   construction.
 *
 *   The question is not American, so neither is the rendering. A row is written through
 *   `formatAddress(components, country, { singleLine: true })` — the per-country layouts in `@mailwoman/codex` — rather
 *   than a template literal. `${locality}, ${region} ${postcode}` is the United States postal order and nothing else:
 *   it prints Japan's admin run backwards, drops the country's own separator convention, and puts a postcode after a
 *   region in the 60-odd systems that lead with it. A country whose layout names no `country` slot renders nothing and
 *   the row is reported as unrenderable, which is a measured absence rather than an invented order.
 *
 *   Usage:
 *
 *       node packages/mailwoman/lib/dev-tools/locality/reachability.run.ts
 *       node packages/mailwoman/lib/dev-tools/locality/reachability.run.ts --country FR --eval <panel.jsonl>
 *       node packages/mailwoman/lib/dev-tools/locality/reachability.run.ts --weights-cache <dir> --out-json <path>
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate-schema"
import { type NameKey, normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { type PanelLocality, readCoordPanel, renderAdmin, suffixTail } from "#dev-tools/coord-panel"
import { buildGauntletDeps } from "#eval-harness/gauntlet/harness"

const { values } = parseArguments({
	options: {
		"out-json": { type: "string" },
		"weights-cache": { type: "string" },
		"candidate-db": { type: "string", default: String(dataRootPath("wof", "candidate.db")) },
		eval: { type: "string", default: String(dataRootPath("eval", "coord", "us.jsonl")) },
		// The country a panel row belongs to, when the panel does not carry one per row.
		// It selects the codex layout the row is written through, so it is a rendering
		// decision before it is a scope one.
		country: { type: "string", default: "US" },
		limit: { type: "string" },
	},
})

/**
 * How a row's locality lookup ended, in the two-cause vocabulary this probe exists to separate.
 *
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
 * How far a candidate row may sit from the panel's own coordinate and still be that row's gold place.
 *
 * Wide enough for a centroid-vs-rooftop offset on a large locality, narrow enough
 * to refuse a namesake one region over — 21 US localities are named Ramsey,
 * and the panel coordinate is the only thing that says which one a row means.
 * A place the panel cannot identify within it is reported as `gold_not_found`
 * rather than folded into a miss, because "we could not name the right answer"
 * and "the run named the wrong one" are different findings.
 */
const GOLD_MAX_KM = 25

/**
 * The `placetype_id` of `locality` in the candidate artifact's `placetype_codes` table.
 */
const LOCALITY_PLACETYPE_ID = 3

/**
 * The gold place for one panel row: the locality whose key is the row's own name
 * and whose coordinate is nearest the panel's.
 *
 * Nearest-by-coordinate rather than highest-population, because the panel row is the disambiguation —
 * 21 US localities are named Ramsey, and the one this row means is the one at its coordinate.
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

/**
 * Whether `sprID` carries a row under `key` — the reachability question,
 * asked of the artifact the run probed.
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

const deps = await buildGauntletDeps(values["weights-cache"] ? { weightsCacheRoot: values["weights-cache"] } : {})

/**
 * Rows whose country has no layout able to write them.
 *
 * Counted and reported rather than dropped: a panel that shrank silently would
 * move every rate below it without saying why.
 */
let unrenderable = 0

const outcomes: Array<{
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

	// A country whose layout writes nothing answers "" rather than an invented order.
	// A row nobody can write is reported as its own class, never graded as a miss.
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

	outcomes.push({
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

for (const row of outcomes) {
	tally.set(row.verdict, (tally.get(row.verdict) ?? 0) + 1)
}

console.log(
	`#2309 locality reachability — ${outcomes.length} localities in ${countriesSeen.size} country/countries` +
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

	// Denominated on graded rows rather than on the panel: an unrenderable row was never asked
	// and counting it would move every share below by an amount the table does not explain.
	console.log(`| ${verdict} | ${n} | ${formatPercent(n, outcomes.length)} |`)
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
 * Rows below this are not reported per word: a rate over fewer places than this reads the draw rather
 * than the word, and the 581-row panel this replaced had 24 of its 34 tail words at one or two rows.
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
	await writeLocalJSONFile(
		{
			panel: panel.length,
			graded: outcomes.length,
			unrenderable,
			countries: [...countriesSeen].toSorted(),
			rows: outcomes,
		},
		values["out-json"]
	)

	console.log(`\nwrote ${values["out-json"]}`)
}
