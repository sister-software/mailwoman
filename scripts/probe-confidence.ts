/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-token confidence-distribution probe. Compares two model checkpoints on the same golden
 *   set: extracts the softmax probability of each predicted label, splits by correct/wrong vs
 *   golden, and emits histograms for visual + statistical comparison.
 *
 *   Purpose: investigate whether v0.6.2's val_loss volatility is overconfidence drift (which
 *   would show as a bimodal high-confidence distribution where wrong predictions also have high
 *   probabilities) or just per-batch sampling noise (which would show similar confidence
 *   distributions across models).
 *
 *   Uses `classifier.parseWithLogits()` (already shipped) to get raw logits per token. Softmax
 *   on the chosen label gives the model's confidence in its argmax prediction. Comparison
 *   against the golden's expected component → bucketize as "matched any expected" / "did not."
 *
 *   Usage:
 *     node --experimental-strip-types scripts/probe-confidence.ts \
 *       --model-a /tmp/v062-eval-step-20000/model.onnx --name-a v0.6.2 \
 *       --model-b /tmp/v062b-eval-step-20000/model.onnx --name-b v0.6.2b \
 *       --tokenizer /mnt/playpen/.../v0.6.0-a0/tokenizer.model \
 *       --model-card neural-weights-en-us/model-card.json \
 *       --golden data/eval/golden/v0.1.2 \
 *       --limit 1000
 */

// Confidence probe only needs raw logits; no tree decode required.
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

interface Args {
	modelAPath: string
	modelBPath: string
	nameA: string
	nameB: string
	tokenizerPath: string
	modelCardPath: string
	goldenDir: string
	limit?: number
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	const out: Partial<Args> = {}
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--model-a" && args[i + 1]) out.modelAPath = args[++i]
		else if (a === "--model-b" && args[i + 1]) out.modelBPath = args[++i]
		else if (a === "--name-a" && args[i + 1]) out.nameA = args[++i]
		else if (a === "--name-b" && args[i + 1]) out.nameB = args[++i]
		else if (a === "--tokenizer" && args[i + 1]) out.tokenizerPath = args[++i]
		else if (a === "--model-card" && args[i + 1]) out.modelCardPath = args[++i]
		else if (a === "--golden" && args[i + 1]) out.goldenDir = args[++i]
		else if (a === "--limit" && args[i + 1]) out.limit = Number(args[++i])
	}
	if (!out.modelAPath || !out.modelBPath || !out.tokenizerPath || !out.modelCardPath || !out.goldenDir) {
		console.error(
			"Usage: probe-confidence.ts --model-a <onnx> --model-b <onnx> --tokenizer <spm> --model-card <json> --golden <dir>"
		)
		process.exit(1)
	}
	out.nameA = out.nameA ?? "A"
	out.nameB = out.nameB ?? "B"
	return out as Args
}

function softmax(row: number[]): number[] {
	let max = -Infinity
	for (const v of row) if (v > max) max = v
	let sum = 0
	const out = new Array<number>(row.length)
	for (let i = 0; i < row.length; i++) {
		const e = Math.exp(row[i]! - max)
		out[i] = e
		sum += e
	}
	for (let i = 0; i < row.length; i++) out[i] = out[i]! / sum
	return out
}

interface GoldenEntry {
	raw: string
	components: Record<string, string>
}

function loadGolden(dir: string, limit?: number): GoldenEntry[] {
	const entries: GoldenEntry[] = []
	for (const file of ["us.jsonl", "fr.jsonl", "adversarial.jsonl"]) {
		const path = resolve(dir, file)
		try {
			const text = readFileSync(path, "utf8")
			for (const line of text.split("\n")) {
				if (!line.trim()) continue
				entries.push(JSON.parse(line))
				if (limit && entries.length >= limit) return entries
			}
		} catch {
			// file may not exist
		}
	}
	return entries
}

async function loadClassifier(
	modelPath: string,
	tokenizerPath: string,
	modelCardPath: string
): Promise<NeuralAddressClassifier> {
	const modelCard = JSON.parse(readFileSync(modelCardPath, "utf8"))
	const labels: readonly string[] = modelCard.labels
	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(tokenizerPath),
		OnnxRunner.create(modelPath),
	])
	return new NeuralAddressClassifier({ tokenizer, runner, labels })
}

interface ConfidenceBuckets {
	correct: number[]
	wrong: number[]
	allOValid: number[] // probabilities for tokens predicted as "O" (no tag); treated separately
}

function bucketEntry(
	rawText: string,
	logits: number[][],
	pieces: ReadonlyArray<{ start: number; end: number }>,
	expected: Record<string, string>,
	buckets: ConfidenceBuckets,
	labels: readonly string[]
): void {
	const expectedValues = new Set<string>()
	for (const v of Object.values(expected)) {
		expectedValues.add(String(v).toLowerCase().trim())
	}

	for (let t = 0; t < logits.length; t++) {
		const probs = softmax(logits[t]!)
		let maxIdx = 0
		let maxProb = probs[0]!
		for (let i = 1; i < probs.length; i++) {
			if (probs[i]! > maxProb) {
				maxProb = probs[i]!
				maxIdx = i
			}
		}
		const label = labels[maxIdx] ?? "O"
		if (label === "O") {
			buckets.allOValid.push(maxProb)
			continue
		}
		// Approximation: slice the piece text from raw, check if it appears as a substring in
		// any expected value. Counts as "correct" if found.
		const p = pieces[t]
		const pieceNorm = p ? rawText.slice(p.start, p.end).toLowerCase() : ""
		let matched = false
		if (pieceNorm.length >= 2) {
			for (const v of expectedValues) {
				if (v.includes(pieceNorm)) {
					matched = true
					break
				}
			}
		}
		if (matched) buckets.correct.push(maxProb)
		else buckets.wrong.push(maxProb)
	}
}

function histogram(values: number[], bins: number[]): number[] {
	const counts = new Array<number>(bins.length).fill(0)
	for (const v of values) {
		for (let i = 0; i < bins.length; i++) {
			if (v <= bins[i]!) {
				counts[i]!++
				break
			}
		}
	}
	return counts
}

function describeDist(values: number[]): string {
	if (values.length === 0) return "(no data)"
	const sorted = [...values].sort((a, b) => a - b)
	const mean = values.reduce((a, b) => a + b, 0) / values.length
	const pct = (q: number) => sorted[Math.floor(sorted.length * q)]
	return (
		`n=${values.length} mean=${mean.toFixed(3)} ` +
		`p10=${pct(0.1)!.toFixed(3)} p25=${pct(0.25)!.toFixed(3)} ` +
		`p50=${pct(0.5)!.toFixed(3)} p75=${pct(0.75)!.toFixed(3)} ` +
		`p90=${pct(0.9)!.toFixed(3)} p95=${pct(0.95)!.toFixed(3)}`
	)
}

async function runModel(
	classifier: NeuralAddressClassifier,
	golden: GoldenEntry[],
	labels: readonly string[]
): Promise<ConfidenceBuckets> {
	const buckets: ConfidenceBuckets = { correct: [], wrong: [], allOValid: [] }
	let count = 0
	for (const entry of golden) {
		const result = await classifier.parseWithLogits(entry.raw)
		bucketEntry(entry.raw, result.logits, result.pieces, entry.components, buckets, labels)
		count++
		if (count % 200 === 0) console.error(`  ${count}/${golden.length}`)
	}
	return buckets
}

async function main(): Promise<void> {
	const args = parseArgs()
	console.error(`Loading golden (limit ${args.limit ?? "none"})...`)
	const golden = loadGolden(args.goldenDir, args.limit)
	console.error(`  ${golden.length} entries`)

	const modelCard = JSON.parse(readFileSync(args.modelCardPath, "utf8"))
	const labels: readonly string[] = modelCard.labels

	console.error(`Loading model A (${args.nameA})...`)
	const a = await loadClassifier(args.modelAPath, args.tokenizerPath, args.modelCardPath)
	console.error(`Running probe on model A...`)
	const bucketsA = await runModel(a, golden, labels)

	console.error(`Loading model B (${args.nameB})...`)
	const b = await loadClassifier(args.modelBPath, args.tokenizerPath, args.modelCardPath)
	console.error(`Running probe on model B...`)
	const bucketsB = await runModel(b, golden, labels)

	const bins = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1.001]

	console.log(`# Confidence distribution probe`)
	console.log(``)
	console.log(`**Golden:** ${golden.length} entries`)
	console.log(`**Model A:** ${args.nameA}`)
	console.log(`**Model B:** ${args.nameB}`)
	console.log(``)
	console.log(`## Per-bucket distributional summary`)
	console.log(``)
	console.log(`### ${args.nameA}`)
	console.log(`- correct (matched piece in expected): ${describeDist(bucketsA.correct)}`)
	console.log(`- wrong (chose tag but piece not in expected): ${describeDist(bucketsA.wrong)}`)
	console.log(`- O-predicted (no tag): ${describeDist(bucketsA.allOValid)}`)
	console.log(``)
	console.log(`### ${args.nameB}`)
	console.log(`- correct: ${describeDist(bucketsB.correct)}`)
	console.log(`- wrong: ${describeDist(bucketsB.wrong)}`)
	console.log(`- O-predicted: ${describeDist(bucketsB.allOValid)}`)
	console.log(``)

	console.log(`## Histograms (chosen-label probability for non-O predictions)`)
	console.log(``)
	console.log(`| bin ≤ | ${args.nameA} correct | ${args.nameA} wrong | ${args.nameB} correct | ${args.nameB} wrong |`)
	console.log(`|---|---|---|---|---|`)
	const histAC = histogram(bucketsA.correct, bins)
	const histAW = histogram(bucketsA.wrong, bins)
	const histBC = histogram(bucketsB.correct, bins)
	const histBW = histogram(bucketsB.wrong, bins)
	for (let i = 0; i < bins.length; i++) {
		console.log(
			`| ${bins[i]!.toFixed(2)} | ${histAC[i]} | ${histAW[i]} | ${histBC[i]} | ${histBW[i]} |`
		)
	}
	console.log(``)

	const wrongHighConfA = bucketsA.wrong.filter((p) => p >= 0.9).length
	const wrongHighConfB = bucketsB.wrong.filter((p) => p >= 0.9).length
	const allWrongA = bucketsA.wrong.length
	const allWrongB = bucketsB.wrong.length
	console.log(`## Overconfidence-on-wrong signal`)
	console.log(``)
	console.log(
		`- ${args.nameA}: ${wrongHighConfA}/${allWrongA} wrong predictions with confidence ≥ 0.9 (${((100 * wrongHighConfA) / Math.max(1, allWrongA)).toFixed(1)}%)`
	)
	console.log(
		`- ${args.nameB}: ${wrongHighConfB}/${allWrongB} wrong predictions with confidence ≥ 0.9 (${((100 * wrongHighConfB) / Math.max(1, allWrongB)).toFixed(1)}%)`
	)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
