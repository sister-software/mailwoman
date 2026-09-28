/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Which WOF place does a Wikidata id actually mean?
 *
 * `gazetteer importance` joins Wikipedia importance onto WOF through `concordances`.
 * That join can map one Wikidata id to several current WOF places. Each place receives the
 * same score. The FST bias is linear in importance. The rule is coincident → keep all, else
 * decisive population → keep the winner, else drop, with coincidence checked first because WOF does
 * not populate every role's row.
 *
 * A wrong concordance with fan-out of one is invisible here: catching it needs evidence the TSV does
 * not carry.
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
	 * WOF population, or 0 when the place has no `place_population` row. zero means absent,
	 * never a zero-population estimate.
	 */
	population: number
}

export interface FanoutResolution {
	verdict: "single" | "coincident" | "population" | "unresolvable"
	/**
	 * The place ids that keep this id's Wikipedia importance.
	 * Empty on `unresolvable`.
	 */
	keep: number[]
}

/**
 * How close candidates must be to read as one place modelled several times
 * rather than different places sharing a Wikidata id.
 *
 * Intra-group max spread across the 7,061 fanned-out groups: p50 2.61 km, p75 5.80,
 * p90 35.84, with 5,044 groups at ≤5 km and only 1,168 more appearing by 25 km,
 * so the distribution has a knee at 5 km.
 */
export const FANOUT_SPREAD_EPSILON_KM = 5

/**
 * Decide which of `candidates` may carry the Wikidata id's importance.
 *
 * Pure and total, a single candidate passes straight through and every multi-candidate
 * group lands in exactly one of the module's branches.
 */
export function resolveConcordanceFanout(candidates: readonly FanoutCandidate[]): FanoutResolution {
	if (candidates.length <= 1) {
		return { verdict: "single", keep: candidates.map((c) => c.id) }
	}

	// Check the whole-group spread.
	// A group of two coincident rows plus one 6,000 km straggler is not coincident.
	// A pairwise-first check would keep the straggler.
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

	// A zero maximum means the population is absent.
	// A tie supplies no evidence.
	// Picking a winner in either case would select by row order.
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
 * Fold one group's resolution into `stats`; singletons are not fan-out and are not counted.
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
