/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Small, pure helpers shared by the two comparison paths.
 */

import { haversineKm } from "@mailwoman/spatial"

import type { GradeRequest } from "#compare"
import type { ConfoundReading } from "#confound"
import type { ExternalAnswer } from "#external-arm"
import { DISTANCE_THRESHOLDS_KM, hitAt } from "#geo-grade"
import type { RecordedAnswer } from "#run-store"
import { assertStratumKey, type ComparedRow, type StratumKey } from "#tool-kit"

/**
 * One row of a cross-engine comparison.
 */
export interface GeoRow extends Omit<ComparedRow, "a" | "b" | "issues_a" | "issues_b"> {
	a: ExternalAnswer
	b: ExternalAnswer
	truth_lat: number | null
	truth_lon: number | null
	truth_tolerance_m: number | null
	truth_type: string | null
	distance_km_a: number | null
	distance_km_b: number | null
}

export function recordAnswers(rows: GeoRow[], side: "a" | "b"): RecordedAnswer[] {
	return rows.map((row) => ({
		id: row.id,
		input: row.input,
		lat: row[side].lat,
		lon: row[side].lon,
		label: row[side].label,
		resultType: row[side].resultType,
		noResultReason: row[side].noResultReason,
	}))
}

/**
 * Maximum separation before truthless arms count as disagreeing, using the protocol's tightest threshold.
 */
export const ARM_SEPARATION_THRESHOLD_KM = DISTANCE_THRESHOLDS_KM[0]!

/**
 * Compare verdicts when truth exists, and arm separation when it does not.
 */
/**
 * Whether the two arms differ at the coordinate level.
 *
 * With truth: the arms land on opposite sides of a protocol threshold (1 / 5 / 25 km), OR, when the row states its own
 * tolerance, on opposite sides of THAT. The protocol thresholds alone graded a rooftop row at kilometre scale: a 100
 * m-tolerance row whose answer moved from the rooftop (0 m) to an interpolated point 198 m away was inside 1 km on both
 * arms and read as no difference, and the regression was found two hours later by an instrument that read the row's
 * tolerance. Without truth: exactly one arm answered, or both answered more than the separation threshold apart.
 */
export function armsDiffered(
	a: ExternalAnswer,
	b: ExternalAnswer,
	distanceA: number | null,
	distanceB: number | null,
	hasTruth: boolean,
	toleranceM: number | null = null
): boolean {
	if (hasTruth) {
		if (DISTANCE_THRESHOLDS_KM.some((threshold) => hitAt(distanceA, threshold) !== hitAt(distanceB, threshold))) {
			return true
		}

		if (toleranceM !== null && toleranceM > 0) {
			const toleranceKm = toleranceM / 1000

			return hitAt(distanceA, toleranceKm) !== hitAt(distanceB, toleranceKm)
		}

		return false
	}

	const answeredA = a.lat !== null && a.lon !== null
	const answeredB = b.lat !== null && b.lon !== null

	if (answeredA !== answeredB) return true

	if (!answeredA) return false

	return haversineKm(a.lat!, a.lon!, b.lat!, b.lon!) > ARM_SEPARATION_THRESHOLD_KM
}

export function resolveGradeMode(request: GradeRequest, hasTruth: boolean, absence: string): "truth" | "diff-only" {
	if (request === "diff-only") return "diff-only"

	if (request === "truth" && !hasTruth) {
		throw new Error(
			`grade: "truth" was requested but ${absence}. Nothing here can be graded — run against {kind:"board"}, or ` +
				'pass grade: "diff-only" to describe the differences without a verdict.'
		)
	}

	return hasTruth ? "truth" : "diff-only"
}

export function withheldVerdict(mode: "truth" | "diff-only", reason: string): Record<string, unknown> {
	return mode === "diff-only" ? { verdict: null, verdict_withheld_reason: reason } : {}
}

export function isolationSentence(confounds: ConfoundReading, exclude: string): string {
	if (confounds.variable_isolation === "clean") return ""

	return `VARIABLE ISOLATION ${confounds.variable_isolation.toUpperCase()}: ${confounds.warnings.filter((warning) => warning !== exclude).join(" ")}`
}

export function assertedStratum(by: string): StratumKey {
	assertStratumKey(by)

	return by
}

/**
 * Whether the two arms answered with different result tiers (`address_point` → `interpolated`, say) — a different claim
 * about the answer even under a stable coordinate, because the tier is what `epistemic_status` reads from. Undefined
 * when either arm did not answer or does not state a tier (external engines and oracles do not), so an absent tier is
 * incomparable, never "same".
 */
export function tierDiffered(a: ExternalAnswer, b: ExternalAnswer): boolean | undefined {
	if (a.lat === null || b.lat === null) return undefined

	if (a.resultType === null || b.resultType === null) return undefined

	return a.resultType !== b.resultType
}
