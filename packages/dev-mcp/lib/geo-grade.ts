/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Grading two arms against a truth coordinate, the only axis a cross-engine comparison has: `grade.ts`'s
 *   component, place-id and tier expectations do not survive an arm answering from a foreign vocabulary, so this module
 *   owns one metric — haversine distance from the top-1 result to the truth point, thresholded at 1 / 5 / 25 km, with a
 *   no-result a miss at every threshold.
 *
 *   A parity claim is a TOST against a bound chosen before the measurement — ±5 pp at 25 km — and it can come back
 *   "not equivalent and not different", the answer an underpowered run should give.
 */

import { haversineKm } from "@mailwoman/spatial"

import { normalCDF, type RowGrade } from "#grade"
import { wilsonInterval } from "#power"

/**
 * The pre-registered distance thresholds: a threshold chosen after seeing
 * where the arms landed is not a threshold.
 */
export const DISTANCE_THRESHOLDS_KM = [1, 5, 25] as const

/**
 * The coarsest threshold, where the metric asks whether the engine found the right
 * place at all; @1 km is a rooftop-precision question.
 */
export const EQUIVALENCE_THRESHOLD_KM = 25

/**
 * Two arms are equivalent only when the whole interval for their difference at
 * {@link EQUIVALENCE_THRESHOLD_KM} sits inside ±5 pp.
 */
const EQUIVALENCE_BOUND_PP = 5

/**
 * Two one-sided tests at 5% make the procedure a 90% confidence interval read against the bound.
 */
const Z_CRITICAL_95_ONE_SIDED = 1.645

const PERCENT = 100

/**
 * A point an arm answered with, or the absence of one.
 */
export interface GeoPoint {
	lat: number | null
	lon: number | null
}

/**
 * `null` is not infinity: it flows into {@link hitAt} as a miss at every threshold
 * while staying distinguishable from an arm that missed by 400 km.
 */
export function distanceKm(answer: GeoPoint, truthLat: number, truthLon: number): number | null {
	if (answer.lat === null || answer.lon === null) return null

	return haversineKm(answer.lat, answer.lon, truthLat, truthLon)
}

/**
 * A no-result is a miss at every threshold (protocol §4).
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
 * Deliberately a HIT/miss comparison rather than "whichever arm is closer":
 * an arm that moves a result from 40 km to 30 km has not found the address, and a metric
 * that rewards it would report progress on rows where no usable result changed.
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
	 * `b − a`, signed, so positive means arm B hit more often.
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
	 * `false` covers both a real difference and too few rows to tell, which is why the
	 * sentence says which rather than leaving `false` to read as "different".
	 */
	equivalent: boolean
	sentence: string
}

/**
 * The instrument for boundary cases the normal approximation cannot describe:
 * it stays wide at `p = 0` and `p = 1`, where the standard error collapses to zero.
 */
function wilsonHalfWidth(successes: number, n: number): number {
	const interval = wilsonInterval(successes, n, Z_CRITICAL_95_ONE_SIDED)

	return (interval.high - interval.low) / 2
}

/**
 * Failing an equivalence test does not mean the arms differ: an estimate already outside the bound
 * is a difference, while a small difference with too wide an interval is an underpowered run.
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
 * The independent-samples standard error is used even though the rows are paired:
 * paired arms are positively correlated, so the true paired variance is smaller,
 * which makes this interval wider and equivalence harder to declare.
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
		// A zero standard error is not zero uncertainty: both arms sat exactly at 0
		// or 1, where the normal approximation has no variance, so the Wilson interval
		// bounds the difference conservatively instead.
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
