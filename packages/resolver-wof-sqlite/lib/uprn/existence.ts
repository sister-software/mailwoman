/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The consult `./lookup.ts`'s docstring instructs: "callers building negative evidence must consult
 *   `readLayerCoverage`, not this reader alone." A bare `null` from `nearestUPRN` is two different facts — no UPRN here,
 *   or nobody surveyed here — and this is the only place that separates them. It answers an {@link Exclusion} or `null`,
 *   so a caller cannot read an unsurveyed cell as an empty one by accident.
 *
 *   `radiusM` is a CALLER'S parameter with no default. There is no radius that is correct for both "which property is
 *   this coordinate" and "is this street built at all", and picking one here would bury that choice where nobody
 *   reviewing an exclusion can see it.
 */

import { readLayerCoverage, readLayerManifest, type LayerContractHandle } from "@mailwoman/core/layers"
import { foldIdentity, requireExclusionBasis, type Exclusion } from "@mailwoman/evidence"
import { shortCellToParentInt } from "@mailwoman/spatial"

import type { UPRNLookup } from "#uprn/lookup"
import { UPRN_COVERAGE_H3_RESOLUTION, UPRN_H3_RESOLUTION, uprnH3Cell } from "#uprn/schema"

/**
 * The identity fold, on purpose: this probe keys on a COORDINATE, not a name, so there is no string folding for the
 * builder and the probe to disagree about. Passing the same identity as both `probeFold` and `layerFold` records that
 * the fold axis is not in play here, rather than silently omitting the check. It is not a stub.
 */
export const UPRN_EXISTENCE_FOLD = foldIdentity((s) => s)

/**
 * The countries OS Open UPRN covers. Northern Ireland is outside the product, so a `null` there is unknown and must
 * never become evidence of absence; the country check is what keeps it out.
 */
export const UPRN_COVERED_COUNTRIES: ReadonlySet<string> = new Set(["GB"])

export interface UPRNAbsenceInput {
	lookup: UPRNLookup
	/**
	 * The same file the lookup reads; the layer contract tables live beside the points.
	 */
	contractDB: LayerContractHandle
	latitude: number
	longitude: number
	radiusM: number
	/**
	 * ISO-2 country of the thing whose absence is being asserted, when known.
	 */
	country?: string
}

/**
 * The coverage cell a coordinate falls in, derived from its stored res-9 cell exactly as the builder derives it — never
 * from the centroid, which lands in a different parent for a fraction of cells.
 */
export function uprnCoverageCell(latitude: number, longitude: number): number {
	return shortCellToParentInt(uprnH3Cell(latitude, longitude), UPRN_H3_RESOLUTION, UPRN_COVERAGE_H3_RESOLUTION)
}

/**
 * An {@link Exclusion} when no UPRN lies within `radiusM` AND the layer's coverage licenses saying so; `null` on a hit
 * (presence is not this probe's business) and on every refusal (unsurveyed cell, `source_present` basis, a country the
 * product does not cover). Never throws on a refusal: the caller falls open to the ranking it already had.
 */
export async function uprnAbsenceAt(input: UPRNAbsenceInput): Promise<Exclusion | null> {
	const coverageCell = uprnCoverageCell(input.latitude, input.longitude)
	const coverage = await readLayerCoverage(input.contractDB, coverageCell)

	if (!coverage) return null

	if (input.lookup.nearestUPRN(input.latitude, input.longitude, input.radiusM)) return null

	const manifest = await readLayerManifest(input.contractDB)

	return requireExclusionBasis({
		layer: manifest.name,
		source: manifest.source,
		vintage: manifest.sourceVintage,
		h3Cell: coverageCell,
		cell: coverage,
		probeFold: UPRN_EXISTENCE_FOLD,
		layerFold: UPRN_EXISTENCE_FOLD,
		country: input.country,
		countries: UPRN_COVERED_COUNTRIES,
	})
}
