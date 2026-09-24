/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Estimate POI-layer completeness with two-source capture-recapture.
 *   Use Chapman's estimator, a pre-registered match-protocol grid, and the weakest
 *   lower confidence bound. Positive dependence between sources can still overstate coverage;
 *   this method bounds sampling error only.
 */

import { foldName } from "@mailwoman/codex/normalize"
import { nameSimilarity } from "@mailwoman/match/comparators"
import { haversineKm } from "@mailwoman/spatial"

/**
 * A row from one of the two inventories, reduced to what the match protocol reads.
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
	 * `[metres, minimum name similarity]` — the close band.
	 */
	near: readonly [number, number]
	/**
	 * `[metres, minimum name similarity]`.
	 * The far band, tighter on names.
	 */
	far: readonly [number, number]
	/**
	 * Metres within which two rows match on position alone, used only when one of them carries no name.
	 */
	unnamedMetres: number
}

/**
 * Pre-registered matching protocols; `strict` is the conservative end.
 */
export const MATCH_PROTOCOL_GRID: readonly MatchProtocol[] = [
	{ label: "strict", near: [25, 0.85], far: [25, 0.85], unnamedMetres: 25 },
	{ label: "primary", near: [50, 0.7], far: [150, 0.9], unnamedMetres: 25 },
	{ label: "loose", near: [100, 0.55], far: [250, 0.85], unnamedMetres: 50 },
]

/**
 * Apply the shared codex match-key fold to nullable POI names.
 */
function foldPOIName(name: string | null): string {
	return name ? foldName(name) : ""
}

/**
 * Metres between two rows.
 */
function metresBetween(a: CaptureRow, b: CaptureRow): number {
	return haversineKm(a.latitude, a.longitude, b.latitude, b.longitude) * 1000
}

/**
 * The widest distance any band of `protocol` accepts — past it no name can rescue a pair.
 */
function widestBand(protocol: MatchProtocol): number {
	return Math.max(protocol.near[0], protocol.far[0], protocol.unnamedMetres)
}

/**
 * Whether `protocol` accepts this pair, and the name similarity it was judged on.
 *
 * `similarity` is 0 both when a row is unnamed and when the pair is beyond {@link widestBand}.
 * No protocol can accept a pair at that distance, so the comparator is skipped
 * rather than run over every one of the O(n1·n2) candidates.
 * Read it only alongside `accepted`.
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

export interface CapturePair {
	first: number
	second: number
	metres: number
	similarity: number
}

/**
 * Greedily assign accepted pairs one-to-one, preferring similarity then distance.
 *
 * Candidate generation is quadratic and intended for pilot-scale inputs.
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

export interface ChapmanEstimate {
	/**
	 * Chapman's bias-corrected population estimate.
	 */
	population: number
	standardError: number
	/**
	 * 95% interval on {@link ChapmanEstimate.population}.
	 */
	lower: number
	upper: number
}

/**
 * Normal-approximation multiplier for a two-sided 95% interval.
 */
const Z_95 = 1.96

/**
 * Compute Chapman's population estimate and variance.
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

export interface ProtocolCompleteness {
	protocol: string
	matched: number
	estimate: ChapmanEstimate
	/**
	 * Point estimate of the second inventory's completeness — the one a pilot
	 * layer built from `second` records.
	 */
	completeness: number
	/**
	 * The conservative reading: `n2` over the upper end of the population interval.
	 */
	completenessLowerBound: number
}

export interface CoverageCompleteness {
	firstCount: number
	secondCount: number
	perProtocol: ProtocolCompleteness[]
	/**
	 * The value a coverage cell records: the weakest lower bound any protocol in the grid supports.
	 */
	recorded: number
	/**
	 * Which protocol produced {@link CoverageCompleteness.recorded}.
	 */
	recordedFrom: string
}

/**
 * Run the whole grid and report the weakest lower bound it supports,
 * which is the value a `surveyed` cell records.
 *
 * Taking the minimum across the grid rather than a chosen protocol's value is what keeps
 * the threshold choice out of the claim: every protocol in the grid is a defensible
 * reading of "the same POI", so the claim is only as strong as the weakest of them.
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
			// A degenerate interval (upper <= 0) can only arise from an empty inventory.
			// Read it as no evidence.
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
