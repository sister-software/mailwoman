/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Opt-in confidence calibration for decoded spans.
 *
 *   The decoder emits a per-span `confidence` that is the mean of the span's per-token softmax
 *   probabilities (`build-tree.ts`). Softmax probabilities are NOT calibrated — a CE-trained model
 *   is systematically over/under-confident in bands. Task #59 fits an isotonic-regression
 *   calibrator on a held-out OpenAddresses + corpus set
 *   (`scripts/eval/fit-isotonic-calibration.py`) and ships the result as a 20-bin lookup table
 *   (`data/eval/calibration/isotonic-<locale>-<version>.json`).
 *
 *   This module turns that table into a pure `(rawConfidence) => calibratedConfidence` function. It
 *   is deliberately decoupled from the table source: pass the PARSED JSON object so this stays
 *   browser-safe (no `node:fs`) — the demo imports the JSON directly, Node scripts `JSON.parse`
 *   it.
 *
 *   Wiring is OPT-IN. The default decode path is unchanged (byte-stable `conf=` output). A caller
 *   that wants calibrated confidences builds a `Calibrator` here and passes it via
 *   `ParseOpts.calibrate` (neural) / `BuildTreeOpts.calibrate` (decoder), which `build-tree.ts`
 *   applies in `flush()`.
 */

/** One row of the lookup table: a confidence bin and the calibrated value at its center. */
export interface CalibrationBin {
	lo: number
	hi: number
	center: number
	calibrated: number
}

/** The full calibration artifact emitted by `fit-isotonic-calibration.py`. */
export interface CalibrationTable {
	model: string
	model_version: string
	method: string
	bins: number
	table: CalibrationBin[]
	[key: string]: unknown
}

/** Maps a raw span confidence in [0, 1] to its calibrated probability of correctness. */
export type Calibrator = (rawConfidence: number) => number

/**
 * Build a calibrator from an isotonic lookup table. The mapping is piecewise-linear between bin centers and clamped to
 * the table's range outside it (the table is monotone non-decreasing by construction, so the interpolation is monotone
 * too). Accepts either the full `CalibrationTable` or a bare `CalibrationBin[]`.
 */
export function createCalibrator(table: CalibrationTable | CalibrationBin[]): Calibrator {
	const bins = Array.isArray(table) ? table : table.table

	if (!bins || bins.length === 0) {
		throw new Error("createCalibrator: empty calibration table")
	}
	// Sort by center and extract parallel arrays for interpolation.
	const sorted = [...bins].sort((a, b) => a.center - b.center)
	const centers = sorted.map((b) => b.center)
	const cals = sorted.map((b) => clamp01(b.calibrated))
	const n = centers.length

	return (raw: number): number => {
		const x = clamp01(raw)

		if (x <= centers[0]!) return cals[0]!

		if (x >= centers[n - 1]!) return cals[n - 1]!
		// Binary search for the interval [centers[i], centers[i+1]] containing x.
		let lo = 0
		let hi = n - 1

		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1

			if (centers[mid]! <= x) {
				lo = mid
			} else {
				hi = mid
			}
		}
		const x0 = centers[lo]!
		const x1 = centers[hi]!
		const y0 = cals[lo]!
		const y1 = cals[hi]!
		const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0)

		return y0 + t * (y1 - y0)
	}
}

function clamp01(v: number): number {
	if (Number.isNaN(v)) return 0

	if (v < 0) return 0

	if (v > 1) return 1

	return v
}
