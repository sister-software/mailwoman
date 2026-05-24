/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Eval script: joint-reconcile vs argmax on kryptonite + golden v0.1.2.
 *
 *   Runs the pipeline twice per golden row — once with `forceJointReconcile: true`, once without —
 *   and computes exact-match rates for both. Applies the DeepSeek synthesis decision matrix:
 *
 *   | Kryptonite Δ exact-match | Golden Δ macro_F1 | Verdict                           |
 *   |--------------------------|-------------------|-----------------------------------|
 *   | ≥ +15pp                  | ≤ −1pt            | Go. Architecture validated.       |
 *   | ≥ +15pp                  | > −1pt            | Golden regression. Fix scoring.   |
 *   | < +15pp                  | ≤ −1pt            | Not earning complexity. Revisit.  |
 *   | < +15pp                  | > −1pt            | Both broken. Step back.           |
 *
 *   Usage:
 *     npx tsx scripts/eval-joint-reconcile.ts
 *
 *   Outputs a JSON report to stdout; human-readable summary to stderr.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createRuntimePipeline } from "mailwoman"

interface GoldenRow {
	raw: string
	components: Record<string, string>
	country: string
	source: string
	notes?: string
}

interface EvalResult {
	raw: string
	expected: Record<string, string>
	argmax: Record<string, string>
	reconciled: Record<string, string>
	argmaxExactMatch: boolean
	reconciledExactMatch: boolean
	isKryptonite: boolean
}

function loadGolden(dir: string): GoldenRow[] {
	const rows: GoldenRow[] = []
	for (const file of ["us.jsonl", "fr.jsonl", "adversarial.jsonl"]) {
		const path = resolve(dir, file)
		try {
			const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean)
			for (const line of lines) {
				rows.push(JSON.parse(line))
			}
		} catch {
			// file may not exist for all locales
		}
	}
	return rows
}

function isKryptonite(row: GoldenRow): boolean {
	return (row.notes ?? "").toLowerCase().includes("kryptonite")
}

function treeToComponents(tree: { roots: Array<{ tag?: string; value?: string }> }): Record<string, string> {
	const out: Record<string, string> = {}
	for (const node of tree.roots ?? []) {
		if (node.tag && node.value) {
			out[node.tag] = node.value
		}
	}
	return out
}

function exactMatch(predicted: Record<string, string>, expected: Record<string, string>): boolean {
	const allKeys = new Set([...Object.keys(predicted), ...Object.keys(expected)])
	for (const key of allKeys) {
		if ((predicted[key] ?? "").trim().toLowerCase() !== (expected[key] ?? "").trim().toLowerCase()) {
			return false
		}
	}
	return true
}

function macroF1(results: EvalResult[], useReconciled: boolean): number {
	const tags = new Set<string>()
	for (const r of results) {
		for (const k of Object.keys(r.expected)) tags.add(k)
	}

	let f1Sum = 0
	let tagCount = 0

	for (const tag of tags) {
		let tp = 0, fp = 0, fn = 0
		for (const r of results) {
			const pred = useReconciled ? r.reconciled[tag] : r.argmax[tag]
			const gold = r.expected[tag]
			if (pred && gold && pred.trim().toLowerCase() === gold.trim().toLowerCase()) {
				tp++
			} else if (pred && !gold) {
				fp++
			} else if (!pred && gold) {
				fn++
			} else if (pred && gold) {
				fp++
				fn++
			}
		}
		const precision = tp / Math.max(tp + fp, 1)
		const recall = tp / Math.max(tp + fn, 1)
		const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
		f1Sum += f1
		tagCount++
	}

	return tagCount > 0 ? f1Sum / tagCount : 0
}

async function main() {
	const goldenDir = resolve("data/eval/golden/v0.1.2")
	const rows = loadGolden(goldenDir)
	console.error(`loaded ${rows.length} golden rows`)

	console.error("loading classifier (v0.4.0 weights)...")
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })

	const pipeline = createRuntimePipeline({ classifier })

	const results: EvalResult[] = []
	let processed = 0

	for (const row of rows) {
		// Argmax path (no joint reconcile)
		const argmaxResult = await pipeline(row.raw, { forceJointReconcile: false })
		const argmaxComponents = treeToComponents(argmaxResult.tree)

		// Joint-reconcile path
		const reconciledResult = await pipeline(row.raw, { forceJointReconcile: true })
		const reconciledComponents = treeToComponents(reconciledResult.tree)

		results.push({
			raw: row.raw,
			expected: row.components,
			argmax: argmaxComponents,
			reconciled: reconciledComponents,
			argmaxExactMatch: exactMatch(argmaxComponents, row.components),
			reconciledExactMatch: exactMatch(reconciledComponents, row.components),
			isKryptonite: isKryptonite(row),
		})

		processed++
		if (processed % 500 === 0) {
			console.error(`  ${processed}/${rows.length}...`)
		}
	}

	// Compute metrics
	const kryptonite = results.filter((r) => r.isKryptonite)
	const normal = results.filter((r) => !r.isKryptonite)
	const all = results

	const krypArgmaxEM = kryptonite.length > 0
		? kryptonite.filter((r) => r.argmaxExactMatch).length / kryptonite.length
		: 0
	const krypReconEM = kryptonite.length > 0
		? kryptonite.filter((r) => r.reconciledExactMatch).length / kryptonite.length
		: 0
	const krypDelta = (krypReconEM - krypArgmaxEM) * 100

	const goldenArgmaxF1 = macroF1(all, false)
	const goldenReconF1 = macroF1(all, true)
	const goldenDelta = (goldenReconF1 - goldenArgmaxF1) * 100

	// Decision matrix
	let verdict: string
	if (krypDelta >= 15 && goldenDelta >= -1) {
		verdict = "GO — architecture validated. Train v0.5.0 weights to beat this."
	} else if (krypDelta >= 15 && goldenDelta < -1) {
		verdict = "GOLDEN REGRESSION — concordance scoring is hot. Fix scoring, retest."
	} else if (krypDelta < 15 && goldenDelta >= -1) {
		verdict = "NOT EARNING COMPLEXITY — revisit scoring/algorithm before training."
	} else {
		verdict = "BOTH BROKEN — step back, diagnose why."
	}

	const report = {
		total_rows: rows.length,
		kryptonite_rows: kryptonite.length,
		normal_rows: normal.length,
		kryptonite: {
			argmax_exact_match: krypArgmaxEM,
			reconciled_exact_match: krypReconEM,
			delta_pp: krypDelta,
			threshold: 15,
			passes: krypDelta >= 15,
		},
		golden: {
			argmax_macro_f1: goldenArgmaxF1,
			reconciled_macro_f1: goldenReconF1,
			delta_pp: goldenDelta,
			threshold: -1,
			passes: goldenDelta >= -1,
		},
		verdict,
	}

	// Human summary to stderr
	console.error("\n" + "=".repeat(70))
	console.error("EVAL: joint-reconcile vs argmax")
	console.error("=".repeat(70))
	console.error(`Total rows: ${rows.length} (kryptonite: ${kryptonite.length}, normal: ${normal.length})`)
	console.error(`\nKryptonite exact-match:`)
	console.error(`  argmax:     ${(krypArgmaxEM * 100).toFixed(1)}%`)
	console.error(`  reconciled: ${(krypReconEM * 100).toFixed(1)}%`)
	console.error(`  Δ:          ${krypDelta >= 0 ? "+" : ""}${krypDelta.toFixed(1)}pp (threshold: ≥+15pp) ${krypDelta >= 15 ? "✓" : "✗"}`)
	console.error(`\nGolden macro_F1:`)
	console.error(`  argmax:     ${(goldenArgmaxF1 * 100).toFixed(1)}%`)
	console.error(`  reconciled: ${(goldenReconF1 * 100).toFixed(1)}%`)
	console.error(`  Δ:          ${goldenDelta >= 0 ? "+" : ""}${goldenDelta.toFixed(1)}pp (threshold: ≥−1pp) ${goldenDelta >= -1 ? "✓" : "✗"}`)
	console.error(`\nVERDICT: ${verdict}`)
	console.error("=".repeat(70))

	// JSON report to stdout
	console.log(JSON.stringify(report, null, 2))
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
