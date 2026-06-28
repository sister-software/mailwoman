/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-region split-conformal multipliers for the interpolation tier's `uncertainty_m` radius
 *   (#374). Multiply the raw claimed radius (half the matched TIGER segment length) by the region's
 *   factor to get a calibrated ~90%-coverage interval.
 *
 *   #569 shipped a single 1.70 measured on Texas; the multi-region recalibration (#584) found the
 *   factor is regional — Q̂ rises monotonically with rurality, 1.44 (DC, densest) → 3.12 (AZ,
 *   sprawl). This wires the per-region selection the seed table anticipated.
 *
 *   SOURCE OF RECORD: `data/calibration/interp-radius-conformal.json` (the eval artifact + rationale,
 *   `docs/articles/evals/2026-06-14-interp-multiregion-recalibration.md`). Embedded here as a
 *   constant so the published package + the server ship it without a runtime data-file dependency.
 *   **Keep the two in sync** — when the full 50-state sweep (followups in the JSON) fills in,
 *   update both.
 */

export interface InterpCalibrationTable {
	/** Uppercase USPS region code → conformal multiplier. */
	byRegion: Record<string, number>
	/**
	 * Multiplier for regions not in the measured set. Deliberately high (near the rural end): under-coverage
	 * (overconfidence) is the harmful error and most unmeasured states skew rural.
	 */
	default: number
}

/**
 * Measured 12-state seed table (a partial sweep; the full 50 was abandoned at the >85 °C heat ceiling). Mirrors
 * `data/calibration/interp-radius-conformal.json` (#584).
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
 * The conformal multiplier for a parsed region. `stateSlug` is the lowercase 2-letter slug from
 * {@link regionToStateSlug} (e.g. `"tx"`); falls back to the table's conservative `default` for an unmeasured or absent
 * region.
 */
export function interpCalibrationForRegion(
	table: InterpCalibrationTable,
	stateSlug: string | null | undefined
): number {
	if (!stateSlug) return table.default

	return table.byRegion[stateSlug.toUpperCase()] ?? table.default
}
