/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Grading two arms against a truth COORDINATE, which is the only axis a cross-engine comparison has.
 *
 *   `grade.ts` grades against expectations — components, place ids, tiers — using the board's own `checkCase`. None of
 *   that survives a comparison with Pelias or Photon: those arms answer with a point and a label from a vocabulary that
 *   is not this repo's, so the only thing both sides genuinely assert is *where the address is*. So this module owns
 *   exactly one metric, the one the benchmark plan pre-registered: haversine distance from the top-1 result to the
 *   truth point, thresholded at 1 / 5 / 25 km, with a no-result a miss at every threshold.
 *
 *   The equivalence test is here for the reason §5.6 gives: a parity claim is not two percentages that look close. It
 *   is a TOST against a bound chosen BEFORE the measurement — ±5 pp at 25 km — and it can come back "not equivalent and
 *   not different", which is the answer an underpowered run should give.
 */

import { haversineKm } from "@mailwoman/spatial"

import { normalCDF, type RowGrade } from "./grade.ts"
import { wilsonInterval } from "./power.ts"

/**
 * The pre-registered distance thresholds, in kilometres. Fixed by
 * `docs/superpowers/plans/2026-08-06-local-pelias-benchmark-rig.md` §4 and adopted verbatim by spec §2.4 — a threshold
 * chosen after seeing where the arms landed is not a threshold.
 */
export const DISTANCE_THRESHOLDS_KM = [1, 5, 25] as const

/**
 * The threshold a head-to-head parity claim is made at, in kilometres. The coarsest of the three: at 25 km the metric
 * is asking "did the engine find the right place at all", which is the question a parity claim is about. @1 km is a
 * rooftop-precision question and the plan's own rule is that it "lives or dies on `truth_type`".
 */
export const EQUIVALENCE_THRESHOLD_KM = 25

/**
 * The pre-registered TOST equivalence bound, in percentage points. Two arms are declared equivalent only when the whole
 * confidence interval for their difference at {@link EQUIVALENCE_THRESHOLD_KM} sits inside ±5 pp.
 */
export const EQUIVALENCE_BOUND_PP = 5

/**
 * One-sided critical z at α = 0.05, the standard TOST pairing — each of the two one-sided tests is run at 5%, which
 * makes the procedure a 90% confidence interval read against the bound.
 */
const Z_CRITICAL_95_ONE_SIDED = 1.645

/**
 * Percentage points per unit proportion.
 */
const PERCENT = 100

/**
 * A point an arm answered with, or the absence of one.
 */
export interface GeoPoint {
	lat: number | null
	lon: number | null
}

/**
 * Distance from an arm's answer to a truth point, or `null` when the arm returned no coordinate.
 *
 * `null` is NOT infinity and must not be turned into one. It flows into {@link hitAt} as a miss at every threshold —
 * which is what the protocol says — while staying distinguishable in the row, so a reader can tell an arm that missed
 * by 400 km from an arm that had nothing to say.
 */
export function distanceKm(answer: GeoPoint, truthLat: number, truthLon: number): number | null {
	if (answer.lat === null || answer.lon === null) return null

	return haversineKm(answer.lat, answer.lon, truthLat, truthLon)
}

/**
 * Whether a distance counts as a hit at one threshold. A no-result is a miss at every threshold (protocol §4).
 */
export function hitAt(distance: number | null, thresholdKm: number): boolean {
	return distance !== null && distance <= thresholdKm
}

/**
 * The key one threshold is reported under, e.g. `25km`.
 */
export function thresholdKey(thresholdKm: number): string {
	return `${thresholdKm}km`
}

/**
 * Grade one row at one threshold.
 *
 * Deliberately a HIT/MISS comparison rather than "whichever arm is closer". An arm that moves a result from 40 km to 30
 * km has not found the address, and a metric that rewards it would report progress on rows where nothing usable
 * changed. The full distances are carried on the row for anyone who wants to read the margin.
 */
export function gradeAtThreshold(distanceA: number | null, distanceB: number | null, thresholdKm: number): RowGrade {
	const a = hitAt(distanceA, thresholdKm)
	const b = hitAt(distanceB, thresholdKm)

	if (a === b) return "neutral"

	return b ? "improved" : "regressed"
}

export interface ThresholdReading {
	a: number
	b: number
	/**
	 * `b − a`, in percentage points. Signed: positive means arm B hit more often.
	 */
	delta_pp: number
	of: number
}

/**
 * Hit counts for both arms at every threshold, over the rows that carry a truth coordinate.
 */
export function thresholdTable(
	rows: Array<{ distanceKmA: number | null; distanceKmB: number | null }>,
	thresholds: readonly number[] = DISTANCE_THRESHOLDS_KM
): Record<string, ThresholdReading> {
	const table: Record<string, ThresholdReading> = {}

	for (const threshold of thresholds) {
		const a = rows.filter((row) => hitAt(row.distanceKmA, threshold)).length
		const b = rows.filter((row) => hitAt(row.distanceKmB, threshold)).length

		table[thresholdKey(threshold)] = {
			a,
			b,
			delta_pp: rows.length ? ((b - a) / rows.length) * PERCENT : 0,
			of: rows.length,
		}
	}

	return table
}

export interface EquivalenceReading {
	test: "TOST (two one-sided z)"
	bound_pp: number
	threshold_km: number
	delta_pp: number
	n: number
	z_lower: number | null
	z_upper: number | null
	p_lower: number | null
	p_upper: number | null
	/**
	 * `true` only when BOTH one-sided tests reject, i.e. the difference is demonstrably inside the bound. `false` covers
	 * two very different situations — a real difference, and too few rows to tell — which is why the sentence says which
	 * one this is rather than leaving `false` to be read as "different".
	 */
	equivalent: boolean
	sentence: string
}

/**
 * Half the width of one proportion's Wilson interval, at the one-sided level TOST is run at. The instrument for the
 * boundary cases the normal approximation cannot describe: it stays wide at `p = 0` and `p = 1`, where the
 * normal-approximation standard error collapses to zero.
 */
function wilsonHalfWidth(successes: number, n: number): number {
	const interval = wilsonInterval(successes, n, Z_CRITICAL_95_ONE_SIDED)

	return (interval.high - interval.low) / 2
}

/**
 * The equivalence verdict as a sentence, which has THREE readings and not two.
 *
 * Failing an equivalence test does not mean the arms differ, and it does not mean nothing was learned — which of those
 * it means depends on where the point estimate fell. A difference already outside the bound is a difference; a small
 * difference with an interval too wide to place is an underpowered run. Wording both as "this is not a claim that the
 * arms differ" would flatly contradict the two-proportion z-test printed beside it, which on a lopsided pair of arms
 * reports a significant gap in the same paragraph.
 */
function equivalence(
	deltaPP: number,
	halfWidthPP: number,
	boundPP: number,
	thresholdKm: number,
	n: number,
	equivalent: boolean
): string {
	const at = `±${boundPP}pp @${thresholdKm}km`
	const interval = `${deltaPP.toFixed(1)}pp, 90% interval ±${halfWidthPP.toFixed(1)}pp, n = ${n}`

	if (equivalent) return `Equivalent at ${at}: the difference is ${interval}, entirely inside the bound.`

	if (Math.abs(deltaPP) > boundPP) {
		return `NOT equivalent at ${at}: the difference is ${interval}, and the estimate itself is already outside the bound.`
	}

	return (
		`NOT equivalent at ${at}: the difference is ${interval}, which crosses the bound. This is not a claim that the ` +
		"arms differ — it is that this run cannot claim they are the same."
	)
}

/**
 * TOST for two proportions against the pre-registered bound.
 *
 * The standard error is the INDEPENDENT-samples one even though the rows are paired. That is the conservative direction
 * and it is chosen on purpose: paired arms over one input set are positively correlated, so the true paired variance is
 * smaller, so this interval is wider and equivalence is harder to declare. An equivalence claim that survives this test
 * survives the paired one; a claim that fails it may only be underpowered, which the sentence says.
 */
export function tostEquivalence(
	successesA: number,
	successesB: number,
	n: number,
	boundPP: number = EQUIVALENCE_BOUND_PP,
	thresholdKm: number = EQUIVALENCE_THRESHOLD_KM
): EquivalenceReading {
	const base = {
		test: "TOST (two one-sided z)" as const,
		bound_pp: boundPP,
		threshold_km: thresholdKm,
		n,
	}

	if (n === 0) {
		return {
			...base,
			delta_pp: 0,
			z_lower: null,
			z_upper: null,
			p_lower: null,
			p_upper: null,
			equivalent: false,
			sentence:
				`No row carried a truth coordinate, so no parity claim at ±${boundPP}pp @${thresholdKm}km is possible. ` +
				"This is the absence of a measurement, not a failure to be equivalent.",
		}
	}

	const proportionA = successesA / n
	const proportionB = successesB / n
	const deltaPP = (proportionB - proportionA) * PERCENT
	const variance = (proportionA * (1 - proportionA) + proportionB * (1 - proportionB)) / n
	const standardErrorPP = Math.sqrt(variance) * PERCENT

	if (standardErrorPP === 0) {
		// A zero standard error is not zero uncertainty. It means both arms sat exactly at 0 or exactly at 1, where the
		// normal approximation has no variance to offer and is simply the wrong instrument: two hits out of two is not
		// evidence of parity. The Wilson interval — the same one `power.ts` cuts its bounds from — still has width
		// there, and the difference is bounded conservatively by the two half-widths together.
		const halfWidthPP = (wilsonHalfWidth(successesA, n) + wilsonHalfWidth(successesB, n)) * PERCENT
		const equivalent = Math.abs(deltaPP) + halfWidthPP <= boundPP

		return {
			...base,
			delta_pp: deltaPP,
			z_lower: null,
			z_upper: null,
			p_lower: null,
			p_upper: null,
			equivalent,
			sentence:
				`Both arms sat at an edge of the scale at ${thresholdKm}km (${successesA} and ${successesB} of ${n}) — every ` +
				`row a hit, or every row a miss, on each side — so the normal approximation has no variance to work with. ` +
				`On the Wilson interval instead, the difference ` +
				`is ${deltaPP.toFixed(1)}pp ±${halfWidthPP.toFixed(1)}pp, which is ${equivalent ? "inside" : "NOT inside"} ` +
				`the ±${boundPP}pp @${thresholdKm}km bound.`,
		}
	}

	const zLower = (deltaPP + boundPP) / standardErrorPP
	const zUpper = (deltaPP - boundPP) / standardErrorPP
	const pLower = 1 - normalCDF(zLower)
	const pUpper = normalCDF(zUpper)
	const equivalent = zLower > Z_CRITICAL_95_ONE_SIDED && zUpper < -Z_CRITICAL_95_ONE_SIDED
	const halfWidthPP = Z_CRITICAL_95_ONE_SIDED * standardErrorPP

	return {
		...base,
		delta_pp: deltaPP,
		z_lower: zLower,
		z_upper: zUpper,
		p_lower: pLower,
		p_upper: pUpper,
		equivalent,
		sentence: equivalence(deltaPP, halfWidthPP, boundPP, thresholdKm, n, equivalent),
	}
}
