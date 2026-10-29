/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fits the isotonic span-confidence calibrator, writes its lookup table and its markdown report.
 *
 *   Usage:
 *     node packages/mailwoman/tools/eval-harness/calibration/isotonic.run.ts \
 *       --conf data/eval/calibration/confidences-v530.jsonl --out data/eval/calibration/isotonic-en-us-v5.3.0.json \
 *       --report <md> [--bins 20 --ece-bins 15 --seed 20260607 --model neural-weights-en-us --model-version 5.3.0]
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { pyFixed } from "@mailwoman/core/numeric"
import { repoRootPath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { pythonJSONDumps } from "@mailwoman/core/strings/python-json"
import { JSONSpliterator } from "spliterator"

import {
	buildPayload,
	fitAndMeasure,
	recordedPermutation,
	renderCalibrationReport,
	seededPermutation,
	type SpanConfidence,
} from "./isotonic.ts"

const { values } = parseArguments({
	options: {
		conf: { type: "string", default: repoRootPath("data/eval/calibration/confidences.jsonl") },
		out: { type: "string", default: repoRootPath("data/eval/calibration/isotonic-en-us-v4.0.0.json") },
		report: {
			type: "string",
			default: repoRootPath("docs/articles/evals/calibration/2026-06-07-isotonic-calibration.md"),
		},
		bins: { type: "string", default: "20" },
		"ece-bins": { type: "string", default: "15" },
		seed: { type: "string", default: "20260607" },
		model: { type: "string", default: "neural-weights-en-us" },
		"model-version": { type: "string", default: "4.0.0" },
	},
})

const repo = repoRootPath()
const records = await Array.fromAsync(JSONSpliterator.fromAsync<SpanConfidence>(values.conf))
const seed = Number(values.seed)
const recorded = await recordedPermutation(seed, records.length)

if (!recorded) {
	console.warn(
		`no recorded NumPy permutation for seed ${seed} and ${records.length} records: the held-out split is ` +
			"mulberry32's, so this is a new fit rather than a refit of a NumPy-split table"
	)
}

const options = {
	model: values.model,
	modelVersion: values["model-version"],
	// The path relative to the repository root, or absolute outside the checkout.
	createdFrom: values.conf.startsWith(`${repo}/`) ? values.conf.slice(repo.length + 1) : values.conf,
	bins: Number(values.bins),
	eceBins: Number(values["ece-bins"]),
}

const fit = fitAndMeasure(records, {
	bins: options.bins,
	eceBins: options.eceBins,
	permutation: recorded ?? seededPermutation(seed, records.length),
})

await writeLocalTextFile(pythonJSONDumps(buildPayload(options, fit), { indent: 2 }) + "\n", values.out)

const m = fit.metrics
const f = (x: { value: number }) => pyFixed(x.value, 4)

console.log(`wrote calibration table → ${values.out}`)
console.log(`  ECE eval: raw ${f(m.ece_raw_eval)} → cal ${f(m.ece_cal_eval)}   (target <0.05)`)
console.log(`  ECE OA-only (held-out): raw ${f(m.ece_raw_oa_eval)} → cal ${f(m.ece_cal_oa_eval)}`)
console.log(`  ECE corpus-only:        raw ${f(m.ece_raw_corpus_eval)} → cal ${f(m.ece_cal_corpus_eval)}`)
console.log(`  MCE eval (bins n>=20): raw ${f(m.mce_raw_eval)} → cal ${f(m.mce_cal_eval)}`)
console.log(`  Brier eval: raw ${f(m.brier_raw_eval)} → cal ${f(m.brier_cal_eval)}`)

await writeLocalTextFile(renderCalibrationReport(options, fit), values.report)

console.log(`wrote report → ${values.report}`)
