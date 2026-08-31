/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Coverage rows and the area check shared by the polygon-layer builders.
 */

import type { CoverageCell } from "#layers/manifest"
import { CoverageBasis } from "#layers/schema"

/**
 * The coverage rows for a layer whose coverage is `source_present`: one per cell the authority's own polygons reach,
 * and none anywhere else.
 *
 * `observedRows` counts the polygons reaching the cell, which is what the contract's column means. There is no zero-row
 * cell here and there cannot be one: a cell with no polygon gets NO ROW, because a `source_present` layer publishes
 * nothing that would let an empty cell be distinguished from unmapped ground. A layer whose absence carries meaning
 * (flood's Zone 1) emits its rows from the designated extent instead, and does not use this.
 */
export function sourcePresentCoverageCells(observed: ReadonlyMap<number, number>): CoverageCell[] {
	const cells: CoverageCell[] = []

	for (const [h3Cell, observedRows] of observed) {
		cells.push({
			h3Cell,
			completeness: 1,
			basis: CoverageBasis.SourcePresent,
			observedRows,
		})
	}

	return cells.toSorted((left, right) => left.h3Cell - right.h3Cell)
}

/**
 * The area a build streamed, beside the area the source reports for itself.
 */
export interface AreaAgreement {
	/**
	 * The rings' total with holes subtracted.
	 */
	nestedKM2: number
	/**
	 * The publisher's own figure.
	 */
	sourceKM2: number
	/**
	 * The same rings read hole-blind, every ring as an exterior.
	 */
	allExteriorKM2: number
	/**
	 * `|nested − source| / source`.
	 */
	relativeGap: number
}

/**
 * Refuse an artifact whose rings do not add up to the area the source itself reports.
 *
 * The message carries the hole-blind total beside the nested one, because the gap between them is the diagnosis: a hole
 * read as an exterior ring answers "inside" for every point in it.
 *
 * @param scope Names the builder in the error, e.g. `coastal build`.
 */
export function assertAreaAgreement(scope: string, area: AreaAgreement, tolerance: number): void {
	if (area.relativeGap <= tolerance) return

	throw new Error(
		`${scope}: the encoded rings total ${area.nestedKM2.toFixed(1)} km² against the source's ${area.sourceKM2.toFixed(1)} km² ` +
			`(${(area.relativeGap * 100).toFixed(2)}% apart, tolerance ${(tolerance * 100).toFixed(0)}%). Read without their holes the same rings total ` +
			`${area.allExteriorKM2.toFixed(1)} km², so compare the two: a hole-blind read answers "inside" for every point in a hole`
	)
}
