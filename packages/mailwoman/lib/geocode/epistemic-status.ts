/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One derivation of a result's epistemic status from its tier, shared by the extractor and the two places that
 *   rewrite a tier afterwards (the fork→entity answer and the plus-code override), so the two fields cannot disagree.
 */

import { CoverageBasis, EpistemicStatus } from "@mailwoman/evidence"

import type { ResolutionTier } from "#geocode/result"

/**
 * WHAT MAY BE CLAIMED about a coordinate, from HOW it was produced and, when the answering register carries one, the
 * coverage basis of the row that answered.
 *
 * - No coordinate → `unresolved`
 * - A register row whose coverage basis is `designated` → `designated` (an authority assigned it)
 * - `interpolated`, `street` and `plus_code` → `derived` (a stated rule computed the point)
 * - Everything else → `observed` (a named source recorded it; no authority is claimed)
 *
 * `inferred` is not producible here: nothing emits a value that is the intersection of constraints rather than a
 * retrieved row. It stays defined and unused rather than repurposed.
 */
export function epistemicStatusFor(
	tier: ResolutionTier,
	lat: number | null,
	basis: string | null | undefined = undefined
): EpistemicStatus {
	if (lat === null) return EpistemicStatus.Unresolved

	if (basis === CoverageBasis.Designated) return EpistemicStatus.Designated

	if (tier === "interpolated" || tier === "street" || tier === "plus_code") return EpistemicStatus.Derived

	return EpistemicStatus.Observed
}
