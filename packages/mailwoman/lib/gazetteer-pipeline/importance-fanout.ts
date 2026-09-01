/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which WOF place does a Wikidata id actually mean? (#1497)
 *
 *   THE DEFECT. `gazetteer importance` joins Nominatim's Wikipedia importance onto WOF through the
 *   `concordances` table, and that join is not a function: on the 2026-08-04 admin DB, **7,061
 *   Wikidata ids name more than one current WOF place**, covering 15,216 places. Every one of them
 *   received the SAME importance. Population importance could never do this — population is a
 *   property of the WOF row and cannot be misjoined — so the defect arrives with the Wikipedia
 *   signal, and it arrives large: `Q1874` (Odessa, UKRAINE) put 0.7138 on a 104-person Minnesota
 *   village, outranking Odessa, Texas (pop 114,000) at 0.5840. `neural/fst-prior.ts` makes the bias
 *   LINEAR in importance, so a bad join is not a rounding error, it is near-maximum decode bias on
 *   the wrong place.
 *
 *   WHY NOT JUST DROP EVERY FANNED-OUT ID. Because measuring first showed that most of the fan-out is
 *   not an error at all. Of the 7,061 groups:
 *
 *   - **5,044 (71.4%, 10,186 places) are COINCIDENT** — one real place that WOF models at several
 *     placetypes at one point. `Q61` is region "District of Columbia" + locality "Washington" +
 *     county "District of Columbia", all at 38.9047/-77.0163 with the same population. Dropping
 *     those would delete the importance of every city-state and consolidated city-county in the
 *     gazetteer.
 *   - **1,619 (22.9%) are POPULATION-RESOLVABLE** — genuinely different places, one decisively
 *     larger. `Q18125` (Manchester, England) is also on Manchester, Pennsylvania (2,788) and
 *     Manchester, Minnesota (53); 547,627 wins.
 *   - **398 (5.6%, 1,009 places) are UNRESOLVABLE** — no population signal or a tie between distant
 *     candidates. `Q340` (Montréal, Canada) sits on two French communes 182 km apart, neither with a
 *     population row. Nothing here says which, and both are wrong, so the id goes.
 *
 *   So the rule is: **coincident → keep all; else decisive population → keep the winner; else drop.**
 *   Net effect 3,411 places lose a wrong score and fall back to the population proxy, while 10,186
 *   legitimate multi-role rows keep theirs.
 *
 *   ORDER MATTERS: coincidence is checked BEFORE population. WOF does not populate every role's row,
 *   so a city-state whose region row has population 0 would otherwise lose that row to its own
 *   locality.
 *
 *   WHAT THIS DOES NOT FIX. A wrong concordance with fan-out of ONE is invisible here — `Q1874` above
 *   is exactly that shape, a single bad edge, and it survives this guard. Catching those needs
 *   evidence this table does not carry (the TSV has only language/type/title/importance/wikidata_id —
 *   no geography), so it is a separate problem and not silently folded in.
 */

import { haversineKm } from "@mailwoman/spatial"

/**
 * A WOF place one Wikidata id claims to name.
 */
export interface FanoutCandidate {
	id: number
	placetype: string
	lat: number
	lon: number
	/**
	 * WOF population, or 0 when the place has no `place_population` row. Zero means ABSENT, never "a population of
	 * nobody" — {@link resolveConcordanceFanout} refuses to treat it as a winner.
	 */
	population: number
}

export interface FanoutResolution {
	verdict: "single" | "coincident" | "population" | "unresolvable"
	/**
	 * The place ids that keep this id's Wikipedia importance. Empty on `unresolvable`.
	 */
	keep: number[]
}

/**
 * How close candidates must be to read as one place modelled several times, rather than as different places sharing a
 * Wikidata id.
 *
 * Measured, not guessed. Intra-group max spread across the 7,061 fanned-out groups: p10 0.12 km, p25 0.91, p50 2.61,
 * p75 5.80, p90 35.84, max 8,848. The distribution has a knee here — 5,044 groups sit at ≤5 km and only 1,168 more
 * appear by 25 km — so 5 km separates "the same settlement described twice" from "two towns with one article between
 * them". Frankfurt's city/neighbourhood pair at 12 km falls OUTSIDE deliberately: they are different places, and
 * population picks the city.
 */
export const FANOUT_SPREAD_EPSILON_KM = 5

/**
 * Decide which of `candidates` may carry the Wikidata id's importance.
 *
 * Pure and total: a single candidate passes straight through, and every multi-candidate group lands in exactly one of
 * the three branches documented in the module header.
 */
export function resolveConcordanceFanout(candidates: readonly FanoutCandidate[]): FanoutResolution {
	if (candidates.length <= 1) {
		return { verdict: "single", keep: candidates.map((c) => c.id) }
	}

	// Whole-group spread, not the first pair: a group of two coincident rows plus one 6,000 km
	// straggler is NOT coincident, and a pairwise-first check would keep the straggler.
	let maxSpread = 0

	for (let i = 0; i < candidates.length && maxSpread <= FANOUT_SPREAD_EPSILON_KM; i++) {
		for (let j = i + 1; j < candidates.length; j++) {
			const a = candidates[i]!
			const b = candidates[j]!
			maxSpread = Math.max(maxSpread, haversineKm(a.lat, a.lon, b.lat, b.lon))

			if (maxSpread > FANOUT_SPREAD_EPSILON_KM) break
		}
	}

	if (maxSpread <= FANOUT_SPREAD_EPSILON_KM) {
		return { verdict: "coincident", keep: candidates.map((c) => c.id) }
	}

	const sorted = [...candidates].toSorted((a, b) => b.population - a.population)
	const top = sorted[0]!
	const runnerUp = sorted[1]!

	// A zero maximum is an ABSENT population, not a small one; a tie is not evidence. Either way,
	// picking a winner would be picking by row order.
	if (top.population > 0 && top.population > runnerUp.population) {
		return { verdict: "population", keep: [top.id] }
	}

	return { verdict: "unresolvable", keep: [] }
}

/**
 * Running tally of what the guard did, for the command's summary line.
 */
export interface FanoutStats {
	fannedGroups: number
	coincidentGroups: number
	populationGroups: number
	unresolvableGroups: number
	droppedPlaces: number
}

export function emptyFanoutStats(): FanoutStats {
	return {
		fannedGroups: 0,
		coincidentGroups: 0,
		populationGroups: 0,
		unresolvableGroups: 0,
		droppedPlaces: 0,
	}
}

/**
 * Fold one group's resolution into `stats`. Singletons are not counted — they are not fan-out.
 */
export function recordFanout(
	stats: FanoutStats,
	candidates: readonly FanoutCandidate[],
	result: FanoutResolution
): void {
	if (result.verdict === "single") return

	stats.fannedGroups++
	stats.droppedPlaces += candidates.length - result.keep.length

	if (result.verdict === "coincident") {
		stats.coincidentGroups++
	} else if (result.verdict === "population") {
		stats.populationGroups++
	} else {
		stats.unresolvableGroups++
	}
}
