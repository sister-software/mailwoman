/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   THE D-RULE MEASUREMENT for ROAD_TO_V9 §2 R1's resolver half.
 *
 *   §2 R1 PREDICTS a resolver delta of zero: today's resolver already ranks namesakes by population,
 *   the split only NAMES that key `referential`, and `referentialFromPopulation` is a monotone
 *   transform of population — so the order cannot move. Predicted is not measured. This probe
 *   measures it, on the live gazetteer, in the one regime where the prediction could fail.
 *
 *   WHERE IT COULD FAIL, AND WHY THAT IS THE WHOLE PROBE. `referentialFromPopulation` is
 *   `min(1, log2(1 + pop/1000) / 14)`: strictly increasing up to `REFERENTIAL_SATURATION_POPULATION`
 *   (16,383,000) and CLAMPED to 1.0 above it. Two places that both clear that line score identically
 *   on referential while population would still separate them. A comparator keyed on referential
 *   ALONE would therefore re-order the world's largest cities — so `compareReferential` carries a raw
 *   population tiebreak, and this probe's job is to confirm (a) that the tiebreak is what makes the two
 *   orderings agree, and (b) how much of the live gazetteer sits in the regime where it matters. A
 *   claim about the saturated tail is exactly the kind of claim AGENTS.md says to spend one command on
 *   rather than reason about.
 *
 *   TWO MEASUREMENTS:
 *
 *   1. **Gazetteer census** — every place at or above saturation, and every NAME-COLLIDING pair where
 *      both bearers clear it. The second number is the population of cases where the tiebreak is
 *      required; if it is zero the tiebreak is insurance, if it is not, it is a bug fix.
 *   2. **Live query replay** — every board query plus the namesake families, run through the real
 *      `findPlace`, with the returned candidate list re-sorted under BOTH the pre-split key and
 *      `compareReferential`. Any row whose id sequence differs is a real resolver delta and is printed.
 *
 *   Usage: node packages/mailwoman/dev-tools/probe-referential-delta.run.ts [--board <path>]
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { compareReferential, REFERENTIAL_SATURATION_POPULATION } from "@mailwoman/core/resolver"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { allRows, dataRootPath, getRow, wofShardPaths } from "@mailwoman/core/utils"
import type { PlaceCandidate } from "@mailwoman/resolver-wof-sqlite"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { loadHardSliceBoard } from "#eval-harness/hard-slice-board"

const { values } = parseArguments({ options: { board: { type: "string" } } })

//#region 1 — Gazetteer census of the saturated tail

const adminPath = String(dataRootPath("wof", "admin-global-priority.db"))

console.log(`## Referential/population ordering — D-rule measurement\n`)
console.log(`Saturation population: ${REFERENTIAL_SATURATION_POPULATION.toLocaleString()}\n`)
console.log(`### 1. Live gazetteer census (\`${adminPath}\`)\n`)

if (!(await pathExists(adminPath))) {
	console.log(`- admin DB absent — census skipped\n`)
} else {
	using db = new DatabaseClient<WOFDatabase>(adminPath, { open: true })

	// `!` because the OUTER count(*) carries no GROUP BY, so SQLite always returns exactly one row.
	const saturated = getRow<{ c: number }>(
		db.prepare("SELECT count(*) AS c FROM place_population WHERE population >= ?"),
		REFERENTIAL_SATURATION_POPULATION
	)!.c

	// The configuration where the tiebreak is required: two CURRENT places sharing a name, both
	// clamped to referential 1.0. Anything less than this cannot produce a differing order.
	// Same one-row guarantee: the GROUP BY is inside the subquery, the outer count(*) has none.
	const collidingPairs = getRow<{ c: number }>(
		db.prepare(
			`SELECT count(*) AS c FROM (
					SELECT s.name FROM spr s JOIN place_population p ON p.id = s.id
					WHERE s.is_current = 1 AND p.population >= ?
					GROUP BY s.name HAVING count(*) > 1
				)`
		),
		REFERENTIAL_SATURATION_POPULATION
	)!.c

	console.log(`- places at or above saturation: **${saturated.toLocaleString()}**`)
	console.log(`- names carrying MORE THAN ONE saturated place: **${collidingPairs.toLocaleString()}**`)

	const top = allRows<{ name: string; country: string; population: number }>(
		db.prepare(
			`SELECT s.name AS name, s.country AS country, p.population AS population
			 FROM spr s JOIN place_population p ON p.id = s.id
			 WHERE s.is_current = 1 AND p.population >= ? ORDER BY p.population DESC LIMIT 10`
		),
		REFERENTIAL_SATURATION_POPULATION
	)

	for (const r of top) {
		console.log(`  - ${r.name} (${r.country}) — ${r.population.toLocaleString()}`)
	}

	console.log("")
}

//#endregion

//#region 2 — Live query replay

/**
 * The pre-split within-tier key, verbatim from `lookup.ts` before the split: raw population DESC, weighted score as the
 * tiebreak. Kept here so the comparison is against the code that shipped, not against a paraphrase of it.
 */
const preSplitKey = (a: PlaceCandidate, b: PlaceCandidate): number =>
	(b.population ?? 0) - (a.population ?? 0) || b.score - a.score

/**
 * The post-split key from the same site.
 */
const postSplitKey = (a: PlaceCandidate, b: PlaceCandidate): number => compareReferential(a, b) || b.score - a.score

const wofPaths: string[] = []

for (const shardPath of wofShardPaths()) {
	if (await pathExists(shardPath)) {
		wofPaths.push(shardPath)
	}
}

console.log(`### 2. Live query replay\n`)

if (!wofPaths.length) {
	console.log(`- no WOF shards found — replay skipped\n`)
} else {
	const { WOFSQLitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
	using lookup = new WOFSQLitePlaceLookup({ databasePath: wofPaths })
	const board = await loadHardSliceBoard(values.board)

	// Board inputs AND their probe surfaces: the input is what a user types, the surface is the token
	// whose namesakes are actually in contention. Both go through the ranking.
	const queries = [...new Set([...board.map((c) => c.input), ...board.map((c) => c.probeSurface)])].toSorted()

	let differing = 0
	let saturatedCandidates = 0
	let compared = 0

	for (const text of queries) {
		let results: PlaceCandidate[]

		try {
			results = await lookup.findPlace({ text, limit: 20 })
		} catch (error) {
			console.log(`- \`${text}\` threw: ${(error as Error).message}`)

			continue
		}

		if (results.length < 2) continue

		compared++

		saturatedCandidates += results.filter((r) => (r.population ?? 0) >= REFERENTIAL_SATURATION_POPULATION).length

		const before = results.toSorted(preSplitKey).map((r) => r.id)
		const after = results.toSorted(postSplitKey).map((r) => r.id)

		if (before.join(",") !== after.join(",")) {
			differing++

			console.log(`- **DIFFERS** \`${text}\`: before=[${before.join(", ")}] after=[${after.join(", ")}]`)
		}
	}

	console.log(`- queries compared (≥2 candidates): **${compared}** of ${queries.length}`)
	console.log(`- candidates at or above saturation across all result sets: **${saturatedCandidates}**`)
	console.log(`- result sets whose ORDER differs pre-split vs post-split: **${differing}**\n`)
}

//#endregion
