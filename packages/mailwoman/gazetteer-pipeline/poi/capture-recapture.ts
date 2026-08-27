/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Two-source capture-recapture over a POI class in a bounded region — the measuring instrument behind a
 *   `CoverageBasis.Surveyed` completeness value. Pure: no ogr2ogr, no SQLite, no network, so the estimator
 *   and the match protocol are testable over synthetic points.
 *
 *   What it computes. Two independently-built inventories of the same class in the same region hold `n1`
 *   and `n2` rows and agree on `m` of them. Chapman's bias-corrected Lincoln-Petersen estimator reads the
 *   population as `N̂ = (n1+1)(n2+1)/(m+1) - 1`, and a source's completeness is its own count over that
 *   population.
 *
 *   Two disciplines are wired in rather than left to the caller, because both control the direction the
 *   number is wrong in:
 *
 *   1. **The recorded value is a lower confidence bound, not a point estimate.** `N̂` sits in the
 *      denominator, so the conservative completeness comes from the UPPER end of `N̂`'s interval.
 *   2. **The protocol is a grid, not a threshold.** A single match rule makes the completeness an artifact
 *      of one threshold choice; {@link completenessAcrossProtocols} runs a pre-registered grid and reports
 *      the weakest bound any of them supports.
 *
 *   What it does NOT correct, and no two-source design can: POSITIVE DEPENDENCE between the sources. If
 *   the same POI is more likely to be in both inventories than chance would have it — a chain branch on a
 *   high street against a single pharmacy on a village lane — then `m` runs high, `N̂` runs low, and
 *   completeness runs HIGH. That is the direction that turns a data gap into confident negative evidence,
 *   so the estimate bounds sampling error only. Breadth past a pilot needs a third source or an
 *   authoritative register, not a wider run of this.
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
 * One match rule. A candidate pair is accepted when it clears the NEAR band, or the FAR band, or — when either row is
 * unnamed, so no name evidence exists — the unnamed distance alone.
 *
 * The two named bands express one idea: the further apart two rows are, the more the names have to agree. The unnamed
 * band is the only place position decides alone, which is why it is the tightest of the three.
 */
export interface MatchProtocol {
	label: string
	/**
	 * `[metres, minimum name similarity]` — the close band.
	 */
	near: readonly [number, number]
	/**
	 * `[metres, minimum name similarity]` — the far band, tighter on names.
	 */
	far: readonly [number, number]
	/**
	 * Metres within which two rows match on position alone, used only when one of them carries no name.
	 */
	unnamedMetres: number
}

/**
 * The pre-registered grid. Fixed BEFORE any completeness value was read off it, and the spread between its ends is the
 * honest width of the measurement — on the pharmacy/Île-de-France pilot it ran 0.6665 to 0.8423.
 *
 * `strict` is the conservative end: it accepts only rows that agree on both position and name, so it under-counts `m`,
 * over-states `N̂`, and under-states completeness.
 */
export const MATCH_PROTOCOL_GRID: readonly MatchProtocol[] = [
	{ label: "strict", near: [25, 0.85], far: [25, 0.85], unnamedMetres: 25 },
	{ label: "primary", near: [50, 0.7], far: [150, 0.9], unnamedMetres: 25 },
	{ label: "loose", near: [100, 0.55], far: [250, 0.85], unnamedMetres: 50 },
]

/**
 * `@mailwoman/codex`'s match-key fold, widened to the nullable name a POI row carries. The fold itself is not
 * re-implemented here: it is the same lossy ASCII key the codex tables are probed by, and a private copy would drift
 * from it silently — `Pharmacie de l'Église` and `PHARMACIE DE L EGLISE` have to reach the comparator as one string.
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
 * `similarity` is 0 both when a row is unnamed and when the pair is beyond {@link widestBand} — no protocol can accept a
 * pair at that distance, so the comparator is skipped rather than run over every one of the O(n1·n2) candidates. Read
 * it only alongside `accepted`.
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
 * One-to-one greedy assignment over the accepted pairs, best first (highest similarity, then closest).
 *
 * One-to-one is load-bearing, not tidiness: `m` is a count of AGREEMENTS between two inventories, so letting one row of
 * the first inventory answer for three rows of the second counts one agreement three times, deflates `N̂`, and inflates
 * completeness — again in the direction that turns a gap into negative evidence.
 *
 * The candidate scan is quadratic in the two inputs. That is deliberate at pilot scale (a few thousand rows a side, a
 * few seconds) and is the wrong shape for a region an order of magnitude larger; the spatial pre-bucket that fixes it
 * belongs with the breadth work, not ahead of the basis review.
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
 * Chapman's estimator and its variance. Chapman rather than plain Lincoln-Petersen because the plain form is undefined
 * at `m = 0` and badly biased at small `m`; the `+1` terms make it defined everywhere and near-unbiased.
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
	 * Point estimate of the SECOND inventory's completeness — the one a pilot layer built from `second` records.
	 */
	completeness: number
	/**
	 * The conservative reading: `n2` over the UPPER end of the population interval.
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
 * Run the whole grid and report the weakest lower bound it supports, which is the value a `surveyed` cell records.
 *
 * Taking the MINIMUM across the grid rather than a chosen protocol's value is what keeps the threshold choice out of
 * the claim: every protocol in the grid is a defensible reading of "the same POI", so the claim is only as strong as
 * the weakest of them.
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
			// A degenerate interval (upper <= 0) can only arise from an empty inventory; read it as no evidence.
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
