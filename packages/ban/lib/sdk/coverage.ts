/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The FR street-centroid layer's coverage basis, computed per commune from BAN's own certification flag.
 *
 *   A commune whose every point is certified is `designated` — the authority declared it whole, so a
 *   miss inside it is evidence of absence. A commune with one uncertified point, or with no flag at
 *   all, is `source_present`: rows exist and no statement has been made about what is missing. The
 *   basis is the commune's own total, never inferred from a share, and the cell inherits the weakest
 *   basis of the communes whose points fall in it.
 */

import type { CoverageCell } from "@mailwoman/core/layers"
import { CoverageBasis } from "@mailwoman/evidence"
import { type H3Cell, shortCellToInt } from "@mailwoman/spatial/h3/cell"
import { latLngToCell } from "h3-js"
/**
 * The resolution `layer_coverage` is written at, matching the OSM and BDC address layers
 * so a consumer's probe walks one cell size across register-backed layers.
 */
export const STREET_CENTROID_COVERAGE_RESOLUTION = 9

export interface CoveragePoint {
	lat: number
	lon: number
	/**
	 * The commune key (`code_insee`), or null for a point that carries none.
	 */
	adminCode: string | null
}

/**
 * Which communes the register declares whole: every point carries `certified = 1`, and a
 * commune with a null flag anywhere is not whole — an absent statement is not a statement.
 *
 * @param flags Per commune, the minimum of its points' `certified` values with null treated as the minimum.
 */
export function wholeCommunes(flags: ReadonlyMap<string, number | null>): ReadonlySet<string> {
	const whole = new Set<string>()

	for (const [adminCode, minimum] of flags) {
		if (minimum === 1) {
			whole.add(adminCode)
		}
	}

	return whole
}

/**
 * Fold the register's points into coverage cells.
 *
 * A cell is `designated` only when every point in it belongs to a whole commune;
 * one point from a partial or unflagged commune makes it `source_present`,
 * because a designated basis licenses an exclusion, and one uncertified street inside
 * the cell is exactly the address such an exclusion would deny.
 */
export function certifiedCoverageCells(points: Iterable<CoveragePoint>, whole: ReadonlySet<string>): CoverageCell[] {
	const cells = new Map<number, { observedRows: number; allWhole: boolean }>()

	for (const point of points) {
		const h3Cell = shortCellToInt(latLngToCell(point.lat, point.lon, STREET_CENTROID_COVERAGE_RESOLUTION) as H3Cell)
		const entry = cells.get(h3Cell) ?? { observedRows: 0, allWhole: true }

		entry.observedRows++
		entry.allWhole &&= point.adminCode !== null && whole.has(point.adminCode)
		cells.set(h3Cell, entry)
	}

	return [...cells].map(([h3Cell, entry]) => ({
		h3Cell,
		completeness: 1,
		basis: entry.allWhole ? CoverageBasis.Designated : CoverageBasis.SourcePresent,
		observedRows: entry.observedRows,
	}))
}
