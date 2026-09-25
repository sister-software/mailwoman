/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Estimates POI-layer completeness from two inventories with Chapman's capture-recapture estimator.
 *
 *   The interval covers sampling error only. When the two sources tend to capture the same places,
 *   the estimate overstates completeness.
 */

import { foldName } from "@mailwoman/codex/normalize"
import { nameSimilarity } from "@mailwoman/match/comparators"
import { haversineKm } from "@mailwoman/spatial"

/**
 * The fields of an inventory row that the match protocol reads.
 */
export interface CaptureRow {
	name: string | null
	latitude: number
	longitude: number
}

/**
 * One name-and-distance matching protocol.
 */
export interface MatchProtocol {
	label: string
	/**
	 * The near band as `[metres, minimum name similarity]`.
	 */
	near: readonly [number, number]
	/**
	 * The far band as `[metres, minimum name similarity]`.
	 * It usually requires closer names.
	 */
	far: readonly [number, number]
	/**
	 * The distance in metres within which two rows match by position when either row has no name.
	 */
	unnamedMetres: number
}

/**
 * The pre-registered matching protocols, from strictest to loosest.
 */
export const MATCH_PROTOCOL_GRID: readonly MatchProtocol[] = [
	{ label: "strict", near: [25, 0.85], far: [25, 0.85], unnamedMetres: 25 },
	{ label: "primary", near: [50, 0.7], far: [150, 0.9], unnamedMetres: 25 },
	{ label: "loose", near: [100, 0.55], far: [250, 0.85], unnamedMetres: 50 },
]

/**
 * Folds a POI name with the shared codex fold.
 * A null name becomes an empty string.
 */
function foldPOIName(name: string | null): string {
	return name ? foldName(name) : ""
}

/**
 * Returns the distance between two rows in metres.
 */
function metresBetween(a: CaptureRow, b: CaptureRow): number {
	return haversineKm(a.latitude, a.longitude, b.latitude, b.longitude) * 1000
}

/**
 * Returns the widest distance that any band of `protocol` accepts.
 */
function widestBand(protocol: MatchProtocol): number {
	return Math.max(protocol.near[0], protocol.far[0], protocol.unnamedMetres)
}

/**
 * Returns whether `protocol` accepts a pair, with the distance and name similarity it used.
 *
 * `similarity` is 0 when a row is unnamed and also when the pair is beyond
 * {@link widestBand}, where the name comparison is skipped.
 * Interpret it only together with `accepted`.
 */
export function evaluatePair(
	a: CaptureRow,
	b: CaptureRow,
	protocol: MatchProtocol
): { accepted: boolean; metres: number; similarity: number } {
	const metres = metresBetween(a, b)

	if (metres > widestBand(protocol)) return { accepted: false, metres, similarity: 0 }

	const foldedA = foldPOIName(a.name)
	const foldedB = foldPOIName(b.name)
	const named = foldedA.length > 0 && foldedB.length > 0
	const similarity = named ? nameSimilarity(foldedA, foldedB) : 0

	const accepted = named
		? (metres <= protocol.near[0] && similarity >= protocol.near[1]) ||
			(metres <= protocol.far[0] && similarity >= protocol.far[1])
		: metres <= protocol.unnamedMetres

	return { accepted, metres, similarity }
}

/**
 * A matched pair, identified by row index in each inventory.
 */
export interface CapturePair {
	first: number
	second: number
	metres: number
	similarity: number
}

/**
 * Matches rows one-to-one, greedily taking accepted pairs by highest similarity and then shortest distance.
 *
 * The candidate search is quadratic, so it suits pilot-scale inputs only.
 */
export function matchInventories(
	first: readonly CaptureRow[],
	second: readonly CaptureRow[],
	protocol: MatchProtocol
): CapturePair[] {
	const candidates: CapturePair[] = []

	for (let i = 0; i < first.length; i++) {
		for (let j = 0; j < second.length; j++) {
			const { accepted, metres, similarity } = evaluatePair(first[i]!, second[j]!, protocol)

			if (accepted) {
				candidates.push({ first: i, second: j, metres, similarity })
			}
		}
	}

	candidates.sort((a, b) => b.similarity - a.similarity || a.metres - b.metres)

	const usedFirst = new Set<number>()
	const usedSecond = new Set<number>()
	const matched: CapturePair[] = []

	for (const candidate of candidates) {
		if (usedFirst.has(candidate.first) || usedSecond.has(candidate.second)) continue

		usedFirst.add(candidate.first)
		usedSecond.add(candidate.second)
		matched.push(candidate)
	}

	return matched
}

/**
 * A Chapman population estimate with its 95% interval.
 */
export interface ChapmanEstimate {
	/**
	 * Chapman's bias-corrected population estimate.
	 */
	population: number
	standardError: number
	/**
	 * The bounds of the 95% normal-approximation interval on {@link ChapmanEstimate.population}.
	 */
	lower: number
	upper: number
}

/**
 * The normal-approximation multiplier for a two-sided 95% interval.
 */
const Z_95 = 1.96

/**
 * Computes Chapman's population estimate and its interval from the two inventory
 * sizes and the matched count.
 */
export function chapmanEstimate(n1: number, n2: number, m: number): ChapmanEstimate {
	if (!Number.isSafeInteger(n1) || !Number.isSafeInteger(n2) || !Number.isSafeInteger(m) || n1 < 0 || n2 < 0 || m < 0) {
		throw new Error(`chapmanEstimate: counts must be non-negative integers, got n1=${n1} n2=${n2} m=${m}`)
	}

	if (m > n1 || m > n2) {
		throw new Error(`chapmanEstimate: matched count ${m} exceeds an inventory size (n1=${n1}, n2=${n2})`)
	}

	const population = ((n1 + 1) * (n2 + 1)) / (m + 1) - 1
	const variance = ((n1 + 1) * (n2 + 1) * (n1 - m) * (n2 - m)) / ((m + 1) * (m + 1) * (m + 2))
	const standardError = Math.sqrt(variance)

	return {
		population,
		standardError,
		lower: population - Z_95 * standardError,
		upper: population + Z_95 * standardError,
	}
}

/**
 * The completeness estimate under one matching protocol.
 */
export interface ProtocolCompleteness {
	protocol: string
	matched: number
	estimate: ChapmanEstimate
	/**
	 * The point estimate of the second inventory's completeness.
	 */
	completeness: number
	/**
	 * The second inventory's size divided by the upper bound of the population interval, capped at 1.
	 */
	completenessLowerBound: number
}

/**
 * The completeness estimates across the protocol grid.
 */
export interface CoverageCompleteness {
	firstCount: number
	secondCount: number
	perProtocol: ProtocolCompleteness[]
	/**
	 * The smallest lower bound across the grid.
	 * A coverage cell records this value.
	 */
	recorded: number
	/**
	 * The protocol that produced {@link CoverageCompleteness.recorded}.
	 */
	recordedFrom: string
}

/**
 * Runs every protocol in the grid and reports the smallest completeness lower bound,
 * which a `surveyed` cell records.
 *
 * Using the minimum keeps the choice of matching thresholds from inflating the claim.
 */
export function completenessAcrossProtocols(
	first: readonly CaptureRow[],
	second: readonly CaptureRow[],
	grid: readonly MatchProtocol[] = MATCH_PROTOCOL_GRID
): CoverageCompleteness {
	if (!grid.length) throw new Error("completenessAcrossProtocols: the protocol grid is empty")

	const perProtocol = grid.map((protocol) => {
		const matched = matchInventories(first, second, protocol).length
		const estimate = chapmanEstimate(first.length, second.length, matched)

		return {
			protocol: protocol.label,
			matched,
			estimate,
			completeness: second.length / estimate.population,
			// An upper bound at or below zero comes only from an empty inventory and gives no evidence.
			completenessLowerBound: estimate.upper > 0 ? Math.min(1, second.length / estimate.upper) : 0,
		}
	})

	let weakest = perProtocol[0]!

	for (const candidate of perProtocol) {
		if (candidate.completenessLowerBound < weakest.completenessLowerBound) {
			weakest = candidate
		}
	}

	return {
		firstCount: first.length,
		secondCount: second.length,
		perProtocol,
		recorded: weakest.completenessLowerBound,
		recordedFrom: weakest.protocol,
	}
}
