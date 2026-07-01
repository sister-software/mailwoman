/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Three-gap-matrix.ts — the routing diagnostic for the 2026-06-19 coordinate-leverage sprint
 *   (docs/articles/plan/2026-06-19-coordinate-leverage-sprint.md). Decomposes every resolution
 *   error into the gap that caused it, because each gap routes to a DIFFERENT, mutually-exclusive
 *   fix:
 *
 *   - Coverage-gap — the right WOF place is NOT in the gazetteer at all → only data ingest helps.
 *   - Recall-gap — the right place IS in the gazetteer but NOT in the resolver's top-k → fix retrieval
 *       (raise k / relax FTS), not ranking.
 *   - Ranking-gap — the right place IS in top-k but mis-ranked (rank > 1) → THIS, and only this, is
 *       what a learned reranker can fix. The ranking-gap fraction is the reranker ceiling.
 *
 *   This isolates the RESOLVER's headroom (it queries the gazetteer with the TRUTH locality, so parse
 *   errors don't contaminate the signal — a reranker operates on correctly-parsed queries). It
 *   needs NO model. For each row it runs ONE `findPlace` at a deep limit to get the ranked
 *   candidate universe, finds the gold place as the nearest same-name locality to the truth
 *   coordinate, then buckets by the gold's rank at each operational k.
 *
 *   Decision rule (sprint doc): ranking_gap (of total) ≥ 0.10 AND coverage_gap < 0.20 → build the
 *   reranker; else expand coverage. DeepSeek's bet: US coverage 12-15%, ranking 3-5% → coverage
 *   wins.
 *
 *   Run (resolver-wof-sqlite must be compiled — `yarn compile`): node --experimental-strip-types
 *   scripts/eval/three-gap-matrix.ts\
 *   --eval data/eval/external/openaddresses-us-sample.jsonl\
 *   --wof-db $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db\
 *   --limit 3000 --out /tmp/reg/three-gap-us.json
 */

import { readFileSync, writeFileSync } from "node:fs"

import { dataRootPath } from "@mailwoman/core/utils"
import { type FindPlaceQuery, WOFSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import { haversineKm } from "@mailwoman/spatial"

import { arg } from "../lib/cli-args.ts"

interface OaRow {
	input: string
	lat: number
	lon: number
	expected: { locality?: string; region?: string; postcode?: string }
	state: string
	source: string
}

/**
 * Normalize a place name for matching: lowercase, strip diacritics + punctuation, expand US abbrevs.
 */
const ABBREV: Record<string, string> = { st: "saint", ste: "sainte", mt: "mount", ft: "fort" }
function normName(s: string | undefined): string {
	if (!s) return ""

	return s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9 ]/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => ABBREV[w] ?? w)
		.join(" ")
		.trim()
}

type Bucket = "correct" | "ranking_gap" | "recall_gap" | "coverage_gap"

async function main(): Promise<void> {
	const evalPath = arg("eval", "data/eval/external/openaddresses-us-sample.jsonl")
	// Two-shard ship config (matches oa-resolver-eval): admin + the coordinate-first postcode→locality
	// table, so passing `postcode` actually injects postcode-proximal candidates (coord-first disabled
	// without the shard). Comma-separated, like the eval.
	const wofDB = arg(
		"wof-db",
		`${dataRootPath("wof", "admin-global-priority.db")},${dataRootPath("wof", "postcode-locality-intl.db")}`
	)
	const limit = parseInt(arg("limit", "3000"), 10)
	const universeK = parseInt(arg("universe", "200"), 10) // deep ranked candidate set per query
	const nearKm = parseFloat(arg("near-km", "35")) // gold = nearest same-name locality within this of truth
	const KS = arg("ks", "5,10,20")
		.split(",")
		.map((s) => parseInt(s.trim(), 10))
	const country = arg("country", "US")

	const rows = readFileSync(evalPath, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as OaRow)
		.filter((r) => r.expected?.locality)
		.slice(0, limit)

	const wofPaths = wofDB
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
	const lookup = new WOFSqlitePlaceLookup({ databasePath: wofPaths.length === 1 ? wofPaths[0]! : wofPaths })

	// Resolve a region name (e.g. "CA", "DC") → its WOF id, the way the resolver does (region lookup,
	// country-scoped). Memoized — "CA" recurs thousands of times. null when unresolved.
	const regionCache = new Map<string, number | null>()
	async function resolveRegionID(region: string | undefined): Promise<number | null> {
		if (!region) return null
		const key = normName(region)

		if (regionCache.has(key)) return regionCache.get(key)!
		const cands = await lookup.findPlace({ text: region, placetype: ["region"], country, limit: 3 })
		const id = cands[0]?.id ?? null
		regionCache.set(key, id)

		return id
	}

	// Per-k bucket counts (coverage is k-independent but counted once per row under every k for clean
	// per-k fractions that sum to 1). Also per-state for the rural-coverage signal.
	const perK = new Map<number, Record<Bucket, number>>()

	for (const k of KS) perK.set(k, { correct: 0, ranking_gap: 0, recall_gap: 0, coverage_gap: 0 })
	const byState = new Map<string, { n: number; coverage_gap: number; ranking_gap20: number; recall_gap20: number }>()
	const rankHist: number[] = [] // 0-based rank of gold among covered rows (universe order)
	const coverageExamples: Array<Record<string, unknown>> = [] // verify coverage gaps are real absences
	const rankingExamples: Array<Record<string, unknown>> = [] // any real ranking gaps, for inspection

	let n = 0

	for (const row of rows) {
		n++

		if (n % 500 === 0) console.error(`  ${n}/${rows.length}`)
		const truth = normName(row.expected.locality)
		const st = byState.get(row.state) ?? { n: 0, coverage_gap: 0, ranking_gap20: 0, recall_gap20: 0 }
		st.n++

		// A candidate IS the gold PLACE if it is the same-name (or alias-exact) locality within nearKm
		// of the truth coordinate. Name + proximity, NOT a specific WOF id — WOF carries duplicate
		// entries for one place (a locality + its localadmin twin, current + deprecated), and we grade
		// the COORDINATE: if the resolver ranks ANY same-name-near-truth entry first, the geocode is
		// correct regardless of which duplicate id it is. (The id-rank version spuriously flagged those
		// as ranking gaps — VT/IL outliers in the first pass.)
		const isGold = (c: { name: string; lat: number; lon: number; exactMatch?: boolean }): boolean =>
			(c.exactMatch || normName(c.name) === truth) && haversineKm(c.lat, c.lon, row.lat, row.lon) <= nearKm

		// (1) COVERAGE — parent-independent. Country-only deep universe; is the right place there at all?
		const covUniverse = await lookup.findPlace({
			text: row.expected.locality!,
			placetype: ["locality"],
			country,
			limit: universeK,
		})

		if (!covUniverse.some(isGold)) {
			// No same-name locality near the truth coordinate → the right instance is not in the gazetteer.
			// Verify it's a REAL absence: did ANY same-name locality exist (anywhere), and how far?
			const nameMatches = covUniverse.filter((c) => c.exactMatch || normName(c.name) === truth)
			const nearestKm = nameMatches.length
				? Math.min(...nameMatches.map((c) => haversineKm(c.lat, c.lon, row.lat, row.lon)))
				: null

			if (coverageExamples.length < 25)
				coverageExamples.push({
					input: row.input,
					locality: row.expected.locality,
					state: row.state,
					name_in_wof: nameMatches.length > 0,
					nearest_same_name_km: nearestKm === null ? null : +nearestKm.toFixed(1),
				})

			for (const k of KS) perK.get(k)!.coverage_gap++
			st.coverage_gap++
			byState.set(row.state, st)
			continue
		}

		// (2) FAITHFUL resolver query: the region as parentID (hard descendant filter) + the sibling
		// postcode (coordinate-first), with the resolver's parent-fallback (retry without parentID when
		// the parent scope returns nothing — resolve.ts). This is the candidate list the resolver
		// ACTUALLY ranks, so the gold's rank here is real ranking headroom, not name-only ambiguity.
		const regionID = await resolveRegionID(row.expected.region)
		const q: FindPlaceQuery = { text: row.expected.locality!, placetype: ["locality"], country, limit: universeK }

		if (regionID != null) q.parentID = regionID

		if (row.expected.postcode) q.postcode = row.expected.postcode
		let faithful = await lookup.findPlace(q)

		if (faithful.length === 0 && q.parentID !== undefined) {
			delete q.parentID
			faithful = await lookup.findPlace(q)
		}
		const rank = faithful.findIndex(isGold)

		// first same-name-near-truth candidate (rank of the right PLACE)

		// (3) bucket by the rank of the right PLACE in the resolver's actual ranked candidate list.
		if (rank < 0) {
			// Covered, but the resolver's real query never surfaces the right place (wrong region scope /
			// coord-first miss / FTS deep-miss) → a retrieval failure, not a ranking one.
			for (const k of KS) perK.get(k)!.recall_gap++
			st.recall_gap20++
			byState.set(row.state, st)
			continue
		}
		rankHist.push(rank)

		if (rank > 0 && rankingExamples.length < 25) {
			const top = faithful[0]
			rankingExamples.push({
				input: row.input,
				locality: row.expected.locality,
				state: row.state,
				gold_rank: rank,
				rank0_name: top?.name,
				rank0_km_from_truth: top ? +haversineKm(top.lat, top.lon, row.lat, row.lon).toFixed(1) : null,
			})
		}

		for (const k of KS) {
			const b = perK.get(k)!

			if (rank === 0) b.correct++
			else if (rank < k) b.ranking_gap++
			else b.recall_gap++
		}

		if (rank !== 0) {
			if (rank < 20) st.ranking_gap20++
			else st.recall_gap20++
		}
		byState.set(row.state, st)
	}

	const pct = (x: number): number => +((100 * x) / n).toFixed(2)
	const summary = {
		eval: evalPath,
		country,
		n,
		universeK,
		nearKm,
		per_k: Object.fromEntries(
			KS.map((k) => {
				const b = perK.get(k)!

				return [
					k,
					{
						correct_pct: pct(b.correct),
						ranking_gap_pct: pct(b.ranking_gap),
						recall_gap_pct: pct(b.recall_gap),
						coverage_gap_pct: pct(b.coverage_gap),
					},
				]
			})
		),
		// The decision-rule inputs (k=10 is the operational beam the rule is written against).
		decision_k10: (() => {
			const b = perK.get(10) ?? perK.get(KS[0]!)!
			const ranking = pct(b.ranking_gap)
			const coverage = pct(b.coverage_gap)
			const route =
				ranking >= 10 && coverage < 20
					? "BUILD_RERANKER"
					: coverage >= 20
						? "EXPAND_COVERAGE"
						: pct(b.recall_gap) >= 15
							? "FIX_RETRIEVAL"
							: "EXPAND_COVERAGE (ranking headroom too small)"

			return { ranking_gap_pct: ranking, coverage_gap_pct: coverage, recall_gap_pct: pct(b.recall_gap), route }
		})(),
		rank_of_gold: {
			n_covered: rankHist.length,
			at_rank_1_pct: rankHist.length
				? +((100 * rankHist.filter((r) => r === 0).length) / rankHist.length).toFixed(1)
				: 0,
			median: rankHist.length ? rankHist.slice().sort((a, b) => a - b)[Math.floor(rankHist.length / 2)] : null,
		},
		worst_states_by_coverage_gap: [...byState.entries()]
			.filter(([, v]) => v.n >= 20)
			.map(([s, v]) => ({
				state: s,
				n: v.n,
				coverage_gap_pct: +((100 * v.coverage_gap) / v.n).toFixed(1),
				ranking_gap20_pct: +((100 * v.ranking_gap20) / v.n).toFixed(1),
			}))
			.sort((a, b) => b.coverage_gap_pct - a.coverage_gap_pct)
			.slice(0, 12),
		coverage_examples: coverageExamples,
		ranking_examples: rankingExamples,
	}
	console.log(JSON.stringify(summary, null, 2))
	const out = arg("out")

	if (out) {
		writeFileSync(out, JSON.stringify(summary, null, 2))
		console.error(`wrote ${out}`)
	}
}

await main()
