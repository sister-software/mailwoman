/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Audits one epoch of a config's source and country mixture as the trainer samples it, prints the mixture with
 *   each source's reps per row, and refuses an epoch below a declared corpus receipt.
 *
 *   The seed is `train.seed + epoch` and the epoch length `train_rows_per_epoch`, unless `--draws` sets it. The
 *   report is written before a refusal. A config that declares receipts gets `meta.corpus_receipt_binding`, the
 *   digest of the config and manifest bytes the audit read.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/audits/epoch-mixture.run.ts --config <yaml> [--json <path>] \
 *       [--corpus-dir <dir>] [--window 100000] [--epoch 1] [--draws <n>]
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { median } from "@mailwoman/core/stats"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"

import { loadTrainingConfig } from "../config.ts"
import { epochRows } from "./census.ts"
import { auditEpochMixture, REPS_OUTLIER_MULTIPLE } from "./epoch-mixture.ts"
import { corpusReceiptBinding, writeAuditReport } from "./receipt.ts"

const { values } = parseArguments({
	options: {
		config: { type: "string" },
		json: { type: "string" },
		"corpus-dir": { type: "string" },
		window: { type: "string", default: "100000" },
		epoch: { type: "string", default: "1" },
		draws: { type: "string" },
	},
})

if (!values.config) throw new Error("--config is required")

const configPath = values.config
const config = await loadTrainingConfig(configPath)
const corpusDir = values["corpus-dir"] ?? config.data.corpus_dir
const epoch = Number(values.epoch)

const { report, error, derivation } = auditEpochMixture(await mtfNode(), config, {
	seed: config.train.seed + epoch,
	draws: epochRows(config, values.draws ? Number(values.draws) : null),
	window: Number(values.window),
	corpusDir,
})

if (derivation) {
	console.log(derivation)
}

report.meta.config = configPath
report.meta.epoch = epoch

if (config.data.required_corpus_receipts.length) {
	report.meta.corpus_receipt_binding = await corpusReceiptBinding(configPath, corpusDir)
}

if (values.json) {
	await writeAuditReport(values.json, report, { ensureASCII: false, trailingNewline: true })
}

const count = (n: number) => n.toLocaleString("en-US")

const fixed = (value: unknown, digits: number) =>
	value == null ? "nan" : (value as { value: number }).value.toFixed(digits)

console.log(`=== epoch mixture audit (${count(report.meta.draws_realized as number)} draws) ===`)

for (const [source, stats] of Object.entries(report.draw_level.per_source)) {
	const emitted = report.emitted_level.per_source[source]

	console.log(
		[
			source.padEnd(28),
			fixed(stats.requested_share, 4).padStart(9),
			count(stats.draws as number).padStart(9),
			fixed(stats.draw_share, 4).padStart(9),
			count((stats.rows as number | null) ?? 0).padStart(9),
			fixed(stats.reps_per_row, 1).padStart(9),
			fixed(stats.max_window_relative_deviation, 3).padStart(11),
			fixed(emitted?.distortion_vs_draw_share, 3).padStart(9),
		].join(" ")
	)
}

console.log(`augmented share of emitted rows: ${fixed(report.emitted_level.augmented_share, 3)}`)

for (const receipt of report.required_corpus_receipts) {
	console.log(`  ${receipt.name}: ${count(receipt.observed_draws)} observed; minimum ${count(receipt.required_draws)}`)
}

const reps = Object.entries(report.draw_level.per_source)
	.map(([source, stats]) => [source, (stats.reps_per_row as { value: number } | null)?.value ?? 0] as const)
	.filter(([, value]) => value)

const medianReps = median(reps.map(([, value]) => value))

if (medianReps != null) {
	const hot = reps.filter(([, value]) => value > medianReps * REPS_OUTLIER_MULTIPLE)

	if (hot.length) {
		console.log(
			`⚠ REPS OUTLIER — median exposure is ${medianReps.toFixed(1)} reps/row; these exceed ${REPS_OUTLIER_MULTIPLE}x that:`
		)

		for (const [source, value] of hot.toSorted((a, b) => b[1] - a[1])) {
			console.log(`    ${source.padEnd(28)} ${value.toFixed(1)} reps/row`)
		}
	}
}

if (error) {
	console.error(error.message)

	process.exitCode = 1
}
