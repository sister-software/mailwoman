/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parser for mailwoman training-run logs. Reads either a Modal app's log output (via
 *   `modal app logs <app-id>` piped through this script) or a saved local log file, and
 *   emits structured `{step, train_loss?, val_loss?, macro_f1?, throughput?}` tuples as
 *   JSON.
 *
 *   Feeds `scripts/training-chart.ts` for visualization.
 *
 *   Log format expected (one record per line; eval lines follow their step line):
 *
 *   ```
 *   step 10000/100000  train_loss=0.0420  lr=0.000150  rate=12.41 steps/s
 *   [eval] val_loss=0.2511  macro_f1=0.4072  val_rows=2048
 *   ```
 *
 *   Train-loss snapshots are emitted per step line. Eval results are paired to the most
 *   recent step. Output is a JSON array on stdout:
 *
 *   ```json
 *   [
 *     {"step": 10000, "train_loss": 0.0420, "lr": 0.00015, "rate": 12.41},
 *     {"step": 10000, "val_loss": 0.2511, "macro_f1": 0.4072, "val_rows": 2048}
 *   ]
 *   ```
 *
 *   Usage:
 *     # From a modal app id (limited to last 100 log entries by default):
 *     modal app logs ap-XXX | node --experimental-strip-types scripts/parse-training-log.ts \
 *       --run-name v0.6.3 > /tmp/v063.json
 *
 *     # From a saved log file:
 *     node --experimental-strip-types scripts/parse-training-log.ts \
 *       --input /tmp/v063-run.log --run-name v0.6.3 --out /tmp/v063.json
 */

import { readFileSync, writeFileSync } from "node:fs"

interface TrainPoint {
	run: string
	step: number
	train_loss?: number
	lr?: number
	rate?: number
	val_loss?: number
	macro_f1?: number
	val_rows?: number
}

interface Args {
	inputPath?: string
	outPath?: string
	runName: string
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	const out: Partial<Args> = {}
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--input" && args[i + 1]) out.inputPath = args[++i]
		else if (a === "--out" && args[i + 1]) out.outPath = args[++i]
		else if (a === "--run-name" && args[i + 1]) out.runName = args[++i]
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

/** Parse the structured training-log CSV that the training loop writes via
 * `csv_log_path`. Schema:
 *   step, wall_seconds, train_loss, lr, val_loss, val_macro_f1, f1.<tag>...
 * Train-only rows have val_loss/val_macro_f1 empty; eval rows fill them in.
 * One row per record (no need to pair train + eval lines like in the modal-log case).
 */
function parseCsv(text: string, runName: string): TrainPoint[] {
	const lines = text.split("\n").filter((l) => l.trim())
	if (lines.length === 0) return []
	const header = lines[0]!.split(",").map((h) => h.trim())
	const stepIdx = header.indexOf("step")
	const trainLossIdx = header.indexOf("train_loss")
	const valLossIdx = header.indexOf("val_loss")
	const macroF1Idx = header.indexOf("val_macro_f1")
	const lrIdx = header.indexOf("lr")
	const out: TrainPoint[] = []
	for (let i = 1; i < lines.length; i++) {
		const cells = lines[i]!.split(",")
		const step = parseInt(cells[stepIdx]!, 10)
		if (Number.isNaN(step)) continue
		const point: TrainPoint = { run: runName, step }
		const tl = trainLossIdx >= 0 ? cells[trainLossIdx] : ""
		if (tl) point.train_loss = parseFloat(tl)
		const vl = valLossIdx >= 0 ? cells[valLossIdx] : ""
		if (vl) point.val_loss = parseFloat(vl)
		const mf = macroF1Idx >= 0 ? cells[macroF1Idx] : ""
		if (mf) point.macro_f1 = parseFloat(mf)
		const lr = lrIdx >= 0 ? cells[lrIdx] : ""
		if (lr) point.lr = parseFloat(lr)
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
	const isCsv = text.split("\n", 1)[0]!.startsWith("step,wall_seconds")
	const points = isCsv ? parseCsv(text, args.runName) : parse(text, args.runName)
	const json = JSON.stringify(points, null, 2)
	if (args.outPath) writeFileSync(args.outPath, json)
	else process.stdout.write(json + "\n")
	console.error(`Parsed ${points.length} records for run '${args.runName}' (${isCsv ? "csv" : "modal-log"} format).`)
}

main()
