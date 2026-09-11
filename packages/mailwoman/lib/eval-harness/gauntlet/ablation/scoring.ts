/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Gauntlet ablation scoring and aggregation.
 */

import { percentile } from "@mailwoman/core/stats"
import { haversineKm } from "@mailwoman/spatial"

import { emptyGrades, PASSING_GRADES, UNCONSTRAINED_RUNG } from "#eval-harness/gauntlet/ablation/expectation"
import {
	type AblatableComponent,
	type AblationCell,
	type AblationRowOutcome,
	DEFAULT_ABLATION_TOLERANCE_KM,
	type SlotOutcome,
} from "#eval-harness/gauntlet/ablation/types"
import { componentOf } from "#eval-harness/gauntlet/check-case"
import type { GauntletResult } from "#eval-harness/gauntlet/harness"
import type { ResolutionTier } from "#eval-harness/gauntlet/schema"

/**
 * Fold to the comparison form used for slot classification: lowercase, alphanumerics only. `BT3 9QQ` and `bt39qq` are
 * the same postcode; `1600` and `BT3 9QQ` are not.
 */
function foldValue(value: string | null): string {
	return (value ?? "").toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, "")
}

/**
 * What the ablated arm did with the deleted component's slot. `substituted` is the S-2 finding-3 class and the one a
 * completion nudge has to fear: the slot reads as filled, so a naive layer abstains — or confirms a house number as a
 * postcode.
 */
export function classifySlot(deleted: string, emitted: string | null): SlotOutcome {
	const got = foldValue(emitted)

	if (!got) return "absent"

	return got === foldValue(deleted) ? "recovered" : "substituted"
}

/**
 * Coarseness rank: higher is more precise. The tier ladder is `address_point → interpolated → street → admin`, and a
 * deletion that walks DOWN it has cost the user precision even when the coordinate barely moved.
 */
export function tierRank(tier: ResolutionTier): number {
	switch (tier) {
		// A resolved entity is house-grade — the poi row is the venue's own point, peer of a situs hit.
		// A decoded plus code is the user's own house-grade claim, peer of both.
		case "venue":
		case "address_point":
		case "plus_code":
			return 4
		case "interpolated":
			return 3
		case "street":
			return 2
		case "admin":
			return 1
	}
}

export function isTierDrop(anchor: ResolutionTier, ablated: ResolutionTier): boolean {
	return tierRank(ablated) < tierRank(anchor)
}

/**
 * Score one deletion against its own anchor. Pure: the two {@linkcode GauntletResult}s are the only inputs, so the
 * scoring rule is testable without the ~9 GB database set.
 */
export function scoreAblation(
	anchor: GauntletResult,
	ablated: GauntletResult,
	deleted: string,
	component: AblatableComponent,
	toleranceKm: number
): Pick<AblationRowOutcome, "displacementKm" | "broken" | "tierDrop" | "unresolved" | "slot" | "emitted"> {
	const anchorResolved = anchor.lat != null && anchor.lon != null
	const ablatedResolved = ablated.lat != null && ablated.lon != null

	const displacementKm =
		anchorResolved && ablatedResolved ? haversineKm(anchor.lat!, anchor.lon!, ablated.lat!, ablated.lon!) : null

	const emitted = componentOf(ablated, component)

	return {
		displacementKm,
		// A row whose own anchor never resolved is NOT gradable — reporting it as held would be the meaning-of-zero
		// trap one level down. A resolved anchor with an unresolved ablated arm IS broken: the answer is gone.
		broken: !anchorResolved ? null : !ablatedResolved ? true : displacementKm! > toleranceKm,
		tierDrop: isTierDrop(anchor.tier, ablated.tier),
		unresolved: !ablatedResolved,
		slot: classifySlot(deleted, emitted),
		emitted,
	}
}

/**
 * Fold per-row outcomes into the (component, locale) map. A pair with no rows produces NO cell — see
 * {@linkcode AblationCell.support}.
 */
export function aggregateCells(
	rows: readonly AblationRowOutcome[],
	meta: { boardID: string; measuredAt: string }
): AblationCell[] {
	const groups = new Map<string, AblationRowOutcome[]>()

	for (const row of rows) {
		const key = `${row.component}|${row.locale}`
		const bucket = groups.get(key)

		if (bucket) {
			bucket.push(row)
		} else {
			groups.set(key, [row])
		}
	}

	const cells: AblationCell[] = []

	for (const bucket of groups.values()) {
		const first = bucket[0]!
		const graded = bucket.filter((r) => r.displacementKm != null).map((r) => r.displacementKm!)
		const grades = emptyGrades()

		for (const row of bucket) {
			grades[row.grade]++
		}

		const ladderGraded = bucket.filter((r) => r.grade !== "ungraded")
		const fell = ladderGraded.filter((r) => r.degradedRungs != null).map((r) => r.degradedRungs!)

		cells.push({
			component: first.component,
			locale: first.locale,
			support: bucket.length,
			brokenCount: bucket.filter((r) => r.broken === true).length,
			// `percentile` returns null on an empty sample; a cell whose anchors all failed has no displacement
			// distribution, and -1 would be a number the reader could average. Encode it as NaN-free absence via
			// gradedCount === 0 — the consumer's rule is "skip a cell you cannot read", same as support 0.
			displacementKmP50: percentile(graded, 50) ?? 0,
			displacementKmP90: percentile(graded, 90) ?? 0,
			tierDropCount: bucket.filter((r) => r.tierDrop).length,
			unresolvedCount: bucket.filter((r) => r.unresolved).length,
			substitutedCount: bucket.filter((r) => r.slot === "substituted").length,
			toleranceKm: DEFAULT_ABLATION_TOLERANCE_KM,
			boardID: meta.boardID,
			measuredAt: meta.measuredAt,
			recoveredCount: bucket.filter((r) => r.slot === "recovered").length,
			anchorUnresolvedCount: bucket.filter((r) => r.broken === null).length,
			gradedCount: graded.length,
			ladderGradedCount: ladderGraded.length,
			grades,
			trueFailCount: ladderGraded.filter((r) => !PASSING_GRADES.has(r.grade)).length,
			correctlyDegradedCount: grades.degraded,
			correctlyAbstainedCount: grades.correctlyAbstained,
			degradedRungsP50: percentile(fell, 50),
			degradedRungsMax: fell.length ? Math.max(...fell) : null,
			unconstrainedCount: bucket.filter((r) => r.expectedRung === UNCONSTRAINED_RUNG).length,
		})
	}

	return cells.toSorted((a, b) => a.component.localeCompare(b.component) || a.locale.localeCompare(b.locale))
}
