/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The coverage probe every polygon layer's reader repeats: an index cell's parent at the coverage
 *   resolution, read through the layer contract's shared row mapping.
 *
 *   NOT exported from this package's main barrel on purpose — it reaches `@mailwoman/core/layers`, and the
 *   barrel serves browser bundles that must not carry the layer contract's Kysely graph. Import it from the
 *   `@mailwoman/spatial/h3/coverage` subpath.
 */

import { toCoverageCell, type CoverageCell, type CoverageRow } from "@mailwoman/core/layers"
import { cellToParent } from "h3-js"

import { shortCellToInt, type H3Cell } from "#h3/cell"

/**
 * The one capability the probe needs of a prepared statement.
 */
export interface CoverageRowProbe {
	get(shortCell: number): unknown
}

/**
 * The coverage row for `indexCell`'s parent at the coverage resolution, or `undefined` when the cell was never surveyed
 * — which a caller must read as UNKNOWN, never as `{completeness: 0}`.
 *
 * The NULL-basis rule lives in the shared mapping: a NULL column is an artifact built before `basis` existed, and it
 * was recording source presence — never a stronger basis than the builder actually had.
 */
export function readCoverageAt(
	select: CoverageRowProbe,
	indexCell: H3Cell,
	coverageResolution: number
): (CoverageCell & { h3CellIndex: string; resolution: number }) | undefined {
	const coverageCell = cellToParent(indexCell, coverageResolution) as H3Cell

	return toCoverageCell(
		select.get(shortCellToInt(coverageCell)) as CoverageRow | undefined,
		coverageCell,
		coverageResolution
	)
}
