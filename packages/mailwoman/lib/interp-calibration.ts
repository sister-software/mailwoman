/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-region split-conformal multipliers for the interpolation tier's `uncertainty_m` radius.
 *   Multiply the raw claimed radius (half the matched tiger segment length) by the region's factor
 *   to get a calibrated ~90%-coverage interval.
 *
 *   The factor is regional, rising with rurality, so the region selects its own multiplier rather
 *   than using one global value.
 *
 *   Source of record: `data/calibration/interp-radius-conformal.json` (the eval artifact and
 *   rationale). Embedded here as a constant so the published package and the server ship it without
 *   a runtime data-file dependency. **Keep the two in sync** when the full 50-state sweep fills in,
 *   and update both.
 */

export interface InterpCalibrationTable {
	/**
	 * Uppercase USPS region code → conformal multiplier.
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
		DC: 1.44,
		NY: 1.53,
		TX: 1.7,
		AK: 1.72,
		CA: 1.87,
		CT: 1.91,
		MI: 1.93,
		AR: 2.24,
		CO: 2.29,
		AL: 2.79,
		MT: 2.85,
		AZ: 3.12,
	},
	default: 1.95,
}

/**
 * The conformal multiplier for a parsed region.
 *
 * `stateSlug` is the lowercase 2-letter slug from {@link regionToStateSlug} (e.g. `"tx"`),
 * and falls back to the table's conservative `default` for an unmeasured or absent region.
 */
export function interpCalibrationForRegion(
	table: InterpCalibrationTable,
	stateSlug: string | null | undefined
): number {
	if (!stateSlug) return table.default

	return table.byRegion[stateSlug.toUpperCase()] ?? table.default
}
