// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Per-region split-conformal multipliers for the interpolation tier's `uncertainty_m` radius.
 *
 *   Multiply the raw claimed radius (half the matched tiger segment length) by the
 *   region's factor to get a calibrated ~90%-coverage interval.
 *
 *   The factor is regional, rising with rurality, so the region selects its own
 *   multiplier rather than using one global value.
 *
 *   Source of record: `data/calibration/interp-radius-conformal.json` (the eval artifact and rationale).
 *   Embedded here as a constant so the published package and the server ship
 *   it without a runtime data-file dependency. **Keep the two in sync**
 *   when the full 50-state sweep fills in. and update both.
 */

export interface InterpCalibrationTable {
	/**
	 * ISO 3166-2 code of a region, such as `US-TX`, → conformal multiplier.
	 */
	byRegion: Record<string, number>
	/**
	 * Multiplier for regions not in the measured set.
	 *
	 * Deliberately high (near the rural end): under-coverage (overconfidence) is the
	 * harmful error and most unmeasured states skew rural.
	 */
	default: number
}

/**
 * The measured 12-state seed table, a partial sweep.
 *
 * Mirrors `data/calibration/interp-radius-conformal.json`.
 */
export const INTERP_RADIUS_CALIBRATION: InterpCalibrationTable = {
	byRegion: {
		"US-DC": 1.44,
		"US-NY": 1.53,
		"US-TX": 1.7,
		"US-AK": 1.72,
		"US-CA": 1.87,
		"US-CT": 1.91,
		"US-MI": 1.93,
		"US-AR": 2.24,
		"US-CO": 2.29,
		"US-AL": 2.79,
		"US-MT": 2.85,
		"US-AZ": 3.12,
	},
	default: 1.95,
}

/**
 * The conformal multiplier for a parsed region.
 *
 * `subdivision` is the region's ISO 3166-2 code, such as `US-TX`, in either case.
 * An unmeasured or absent region reads the table's conservative `default`.
 */
export function interpCalibrationForRegion(
	table: InterpCalibrationTable,
	subdivision: string | null | undefined
): number {
	if (!subdivision) return table.default

	return table.byRegion[subdivision.toUpperCase()] ?? table.default
}
