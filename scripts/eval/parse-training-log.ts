/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parser for mailwoman training-run logs. Reads either a Modal app's log output (via `modal app
 *   logs <app-id>` piped through this script) or a saved local log file, and emits structured
 *   `{step, train_loss?, val_loss?, macro_f1?, throughput?}` tuples as JSON.
 *
 *   Feeds `scripts/training-chart.ts` for visualization.
 *
 *   Log format expected (one record per line; eval lines follow their step line):
 *
 *   ```
 *   step 10000/100000  train_loss=0.0420  lr=0.000150  rate=12.41 steps/s
 *   [eval] val_loss=0.2511  macro_f1=0.4072  val_rows=2048
 * ```
 *
 *   Train-loss snapshots are emitted per step line. Eval results are paired to the most recent step.
 *   Output is a JSON array on stdout:
 *
 *   ```json
 *   [
 *     {"step": 10000, "train_loss": 0.0420, "lr": 0.00015, "rate": 12.41},
 *     {"step": 10000, "val_loss": 0.2511, "macro_f1": 0.4072, "val_rows": 2048}
 *   ]
 * ```
 *
 *   Usage:
 *
 *   # From a modal app id (limited to last 100 log entries by default):
 *
 *   Modal app logs ap-XXX | node scripts/parse-training-log.ts\
 *   --run-name v0.6.3 > /tmp/v063.json
 *
 *   # From a saved log file:
 *
 *   node scripts/parse-training-log.ts\
 *   --input /tmp/v063-run.log --run-name v0.6.3 --out /tmp/v063.json
 */

import { readFileSync, writeFileSync } from "node:fs"
import { parseArgs as parseNodeArgs } from "node:util"

interface TrainPoint {
	run: string
	step: number
	train_loss?: number
	lr?: number
	rate?: number
	val_loss?: number
	macro_f1?: number
	val_rows?: number
	// Per-tag F1 values from the CSV's f1.<tag> columns. Sparse — only eval rows have them.
	[per_tag: `f1.${string}`]: number | string | undefined
}

interface Args {
	inputPath?: string
	outPath?: string
	runName: string
}

function parseArgs(): Args {
	const out: Partial<Args> = {}

	// node:util parseArgs (strict:false = old scan parity: unknown flags tolerated)
	const { values } = parseNodeArgs({
		options: { input: { type: "string" }, out: { type: "string" }, "run-name": { type: "string" } },
		strict: false,
		allowPositionals: true,
	})

	if (values["input"] != null) {
		out.inputPath = values["input"] as string
	}

	if (values["out"] != null) {
		out.outPath = values["out"] as string
	}

	if (values["run-name"] != null) {
		out.runName = values["run-name"] as string
	}

	if (!out.runName) {
		console.error("Usage: parse-training-log.ts --run-name <label> [--input <file>] [--out <json>]")
		console.error("Without --input, reads from stdin.")
		process.exit(1)
	}

	return out as Args
}

const STEP_RE = /step (\d+)\/\d+\s+train_loss=([\d.]+)\s+lr=([\d.eE+-]+)\s+rate=([\d.]+)/
const EVAL_RE = /\[eval\]\s+val_loss=([\d.]+)\s+macro_f1=([\d.]+)\s+val_rows=(\d+)/

function readInput(args: Args): string {
	if (args.inputPath) return readFileSync(args.inputPath, "utf8")

	return readFileSync("/dev/stdin", "utf8")
}

/**
 * Parse the structured training-log CSV that the training loop writes via `csv_log_path`. Schema: step, wall_seconds,
 * train_loss, lr, val_loss, val_macro_f1, f1.<tag>... Train-only rows have val_loss/val_macro_f1 empty; eval rows fill
 * them in. One row per record (no need to pair train + eval lines like in the modal-log case).
 */
function parseCSV(text: string, runName: string): TrainPoint[] {
	const lines = text.split("\n").filter((l) => l.trim())

	if (lines.length === 0) return []
	const header = lines[0]!.split(",").map((h) => h.trim())
	const stepIdx = header.indexOf("step")
	const trainLossIdx = header.indexOf("train_loss")
	const valLossIdx = header.indexOf("val_loss")
	const macroF1Idx = header.indexOf("val_macro_f1")
	const lrIdx = header.indexOf("lr")
	// Identify per-tag F1 columns dynamically — schema has `f1.<tag>` columns whose set
	// depends on Stage 1 vs Stage 2 vs Stage 3. Index them once.
	const perTagIdx: Array<{ key: string; idx: number }> = []

	for (let i = 0; i < header.length; i++) {
		if (header[i]!.startsWith("f1.")) {
			perTagIdx.push({ key: header[i]!, idx: i })
		}
	}

	const out: TrainPoint[] = []

	for (let i = 1; i < lines.length; i++) {
		const cells = lines[i]!.split(",")
		const step = parseInt(cells[stepIdx]!, 10)

		if (Number.isNaN(step)) continue
		const point: TrainPoint = { run: runName, step }
		const tl = trainLossIdx >= 0 ? cells[trainLossIdx] : ""

		if (tl) {
			point.train_loss = parseFloat(tl)
		}
		const vl = valLossIdx >= 0 ? cells[valLossIdx] : ""

		if (vl) {
			point.val_loss = parseFloat(vl)
		}
		const mf = macroF1Idx >= 0 ? cells[macroF1Idx] : ""

		if (mf) {
			point.macro_f1 = parseFloat(mf)
		}
		const lr = lrIdx >= 0 ? cells[lrIdx] : ""

		if (lr) {
			point.lr = parseFloat(lr)
		}

		for (const { key, idx } of perTagIdx) {
			const v = cells[idx]

			if (v) {
				point[key as `f1.${string}`] = parseFloat(v)
			}
		}
		out.push(point)
	}

	return out
}

function parse(text: string, runName: string): TrainPoint[] {
	const out: TrainPoint[] = []
	let lastStep = 0

	for (const line of text.split("\n")) {
		const stepMatch = STEP_RE.exec(line)

		if (stepMatch) {
			lastStep = parseInt(stepMatch[1]!, 10)
			out.push({
				run: runName,
				step: lastStep,
				train_loss: parseFloat(stepMatch[2]!),
				lr: parseFloat(stepMatch[3]!),
				rate: parseFloat(stepMatch[4]!),
			})
			continue
		}
		const evalMatch = EVAL_RE.exec(line)

		if (evalMatch && lastStep > 0) {
			out.push({
				run: runName,
				step: lastStep,
				val_loss: parseFloat(evalMatch[1]!),
				macro_f1: parseFloat(evalMatch[2]!),
				val_rows: parseInt(evalMatch[3]!, 10),
			})
		}
	}
	// Deduplicate consecutive identical step+metric records (Modal logs often re-emit the
	// same line in our streaming-poll monitor pattern).
	const seen = new Set<string>()
	const deduped: TrainPoint[] = []

	for (const p of out) {
		const key = `${p.step}|${p.train_loss ?? ""}|${p.val_loss ?? ""}|${p.macro_f1 ?? ""}`

		if (seen.has(key)) continue
		seen.add(key)
		deduped.push(p)
	}

	return deduped
}

function main(): void {
	const args = parseArgs()
	const text = readInput(args)
	// Auto-detect format: CSV files start with a header that includes "step,wall_seconds".
	const isCSV = text.split("\n", 1)[0]!.startsWith("step,wall_seconds")
	const points = isCSV ? parseCSV(text, args.runName) : parse(text, args.runName)
	const json = JSON.stringify(points, null, 2)

	if (args.outPath) {
		writeFileSync(args.outPath, json)
	} else {
		process.stdout.write(json + "\n")
	}
	console.error(`Parsed ${points.length} records for run '${args.runName}' (${isCSV ? "csv" : "modal-log"} format).`)
}

main()
