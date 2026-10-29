/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The calibration drift guard (#368 S6): re-applies a committed table to its confidences and exits 1 when the
 *   held-out calibrated ECE moved more than `--tolerance` from the value the table records.
 *
 *   A swapped model or regenerated confidences left without a refit make the `conf=` a table produces drift out of
 *   calibration without an error. The guard measures on the held-out fifth the fit measured on, through the same
 *   recorded permutation, and exits 2 when the table records no calibrated ECE to compare with.
 *
 *   Usage:
 *     node packages/mailwoman/tools/eval-harness/calibration/drift-guard.run.ts \
 *       --table data/eval/calibration/isotonic-en-us-v5.3.0.json --conf data/eval/calibration/confidences-v530.jsonl \
 *       [--tolerance 0.02 --seed 20260607]
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pyFixed } from "@mailwoman/core/numeric"
import { repoRootPath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { JSONSpliterator } from "spliterator"

import { ece, recordedPermutation, seededPermutation, type SpanConfidence } from "./isotonic.ts"
import { numpyInterp } from "./numpy.ts"

/**
 * The bins the guard's ECE reads, as the fit's `--ece-bins` default.
 */
const GUARD_ECE_BINS = 15

const { values } = parseArguments({
	options: {
		table: { type: "string", default: repoRootPath("data/eval/calibration/isotonic-en-us-v4.0.0.json") },
		conf: { type: "string", default: repoRootPath("data/eval/calibration/confidences.jsonl") },
		tolerance: { type: "string", default: "0.02" },
		seed: { type: "string", default: "20260607" },
	},
})

const table = await readLocalJSONFile<{
	metrics?: { ece_cal_eval?: number }
	table: Array<{ center: number; calibrated: number }>
}>(values.table)

const recorded = table.metrics?.ece_cal_eval

if (recorded == null) {
	console.error(`DRIFT-GUARD: table ${values.table} has no metrics.ece_cal_eval — cannot check`)

	process.exit(2)
}

const bins = table.table.toSorted((a, b) => a.center - b.center)
const centers = bins.map((b) => b.center)
const calibrated = bins.map((b) => b.calibrated)
const records = await Array.fromAsync(JSONSpliterator.fromAsync<SpanConfidence>(values.conf))
const seed = Number(values.seed)
const permutation = (await recordedPermutation(seed, records.length)) ?? seededPermutation(seed, records.length)
const held = permutation.slice(0, Math.floor(records.length / 5))

const observed = records.length
	? ece(
			held.map((i) => numpyInterp(records[i]!.conf, centers, calibrated)),
			held.map((i) => (records[i]!.correct ? 1 : 0)),
			GUARD_ECE_BINS
		).e
	: 0

const tolerance = Number(values.tolerance)
const drift = Math.abs(observed - recorded)
const ok = drift <= tolerance

console.log(
	`[${ok ? "OK" : "DRIFT"}] calibrated ECE: recorded ${pyFixed(recorded, 4)} vs observed ${pyFixed(observed, 4)} ` +
		`(drift ${pyFixed(drift, 4)}, tolerance ${values.tolerance})`
)

process.exitCode = ok ? 0 : 1
