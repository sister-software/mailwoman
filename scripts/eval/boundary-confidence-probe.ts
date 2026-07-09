/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #375 boundary CONFIDENCE PROBE — the cheap diagnostic (DeepSeek consult 2026-06-18) that decides,
 *   per shape, whether a missed boundary target is a SIGNAL problem (the model is confidently WRONG
 *   — augmentation fixes it) or a CAPACITY ceiling (the model is high-entropy/uncertain — only a
 *   bigger model fixes it). For each shape we locate the boundary token by char-offset, softmax its
 *   RAW per-token logits (pre-prior, pre-repair — the model's intrinsic belief), and read off:
 *
 *   - P(correct tag) at the boundary token
 *   - The argmax label + its probability (when wrong: is it confidently wrong or smeared?)
 *   - The histogram of what the boundary gets confused FOR (e.g. locality -> I-street = "street ate
 *       it")
 *
 *   Run: node scripts/eval/boundary-confidence-probe.ts\
 *   --model ./out/v160/model.onnx\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json --n 200
 */

import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { NeuralAddressClassifier } from "@mailwoman/neural"

import {
	type BoundaryStressTemplate,
	synthesizeBoundaryStressRow,
} from "../../corpus/src/synthesize-boundary-stress.ts"

const { values: args } = parseArgs({
	options: {
		model: { type: "string" },
		tokenizer: { type: "string" },
		"model-card": { type: "string" },
		n: { type: "string", default: "200" },
	},
})
const N = Number(args.n)

if (args.model && !args.tokenizer) throw new Error("--tokenizer required with --model")

// The boundary token we probe per shape, and where it sits relative to the street (for disambiguating
// duplicate substrings). For comma-less we probe the LOCALITY start — that's the regression site
// (us.locality 66.2/72.9): does the model confidently extend street INTO the locality?
const PROBES: Partial<Record<BoundaryStressTemplate, { tag: string; prefer: "first" | "last"; why: string }>> = {
	"street-eats-affix": { tag: "street_suffix", prefer: "last", why: "suffix swallowed into street?" },
	"comma-less-city-state": { tag: "locality", prefer: "first", why: "street eats the locality start?" },
	"fr-prefix": { tag: "street_prefix", prefer: "first", why: "leading particle (the shape that PASSED)" },
	"house-number-after-street": { tag: "house_number", prefer: "last", why: "trailing number swallowed/dropped?" },
}

const card = JSON.parse(readFileSync(args["model-card"] ?? "neural-weights-en-us/model-card.json", "utf8"))
const LABELS: string[] = card.labels
const idxOf = (name: string) => LABELS.indexOf(name)

function softmax(logits: number[]): number[] {
	const m = Math.max(...logits)
	const ex = logits.map((x) => Math.exp(x - m))
	const s = ex.reduce((a, b) => a + b, 0)

	return ex.map((x) => x / s)
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** Char span [start,end) of `value` in `raw` at a word boundary; prefer first/last occurrence. */
function locateSpan(raw: string, value: string, prefer: "first" | "last"): [number, number] | null {
	if (!value) return null
	const re = new RegExp(`\\b${esc(value)}\\b`, "g")
	const hits: number[] = []

	for (let m = re.exec(raw); m; m = re.exec(raw)) {
		hits.push(m.index)
	}

	if (hits.length === 0) {
		const i = raw.indexOf(value)

		return i < 0 ? null : [i, i + value.length]
	}
	const start = prefer === "last" ? hits[hits.length - 1]! : hits[0]!

	return [start, start + value.length]
}

const loadOpts = args.model
	? { locale: "en-US", modelPath: args.model, tokenizerPath: args.tokenizer, modelCardPath: args["model-card"] }
	: { locale: "en-US" }
const classifier = await NeuralAddressClassifier.loadFromWeights(loadOpts)
const random = (() => {
	let a = 20260618 >>> 0

	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
})()

console.log(`\n== boundary confidence probe — ${args.model ?? "dev weights"} (raw logits, n=${N}/shape) ==`)

for (const template of Object.keys(PROBES) as BoundaryStressTemplate[]) {
	const { tag, prefer, why } = PROBES[template]!
	const bIdx = idxOf(`B-${tag}`)
	let located = 0
	let correct = 0
	const pCorrectAll: number[] = []
	const pArgmaxWhenWrong: number[] = []
	const confusedFor: Record<string, number> = {}

	for (let i = 0; i < N; i++) {
		const row = synthesizeBoundaryStressRow(undefined, { random, forceTemplate: template })
		const goldVal = String(row.components[tag as keyof typeof row.components] ?? "")
		const span = locateSpan(row.raw, goldVal, prefer)

		if (!span) continue
		const { logits, pieces } = await classifier.parseWithLogits(row.raw)
		const pi = pieces.findIndex((p) => p.end > span[0] && p.start < span[1])

		if (pi < 0 || !logits[pi]) continue
		located++
		const probs = softmax(logits[pi]!)
		const pCorrect = probs[bIdx] ?? 0
		pCorrectAll.push(pCorrect)
		let argmax = 0

		for (let k = 1; k < probs.length; k++)
			if (probs[k]! > probs[argmax]!) {
				argmax = k
			}
		const argmaxLabel = LABELS[argmax] ?? "?"

		if (argmax === bIdx) {
			correct++
		} else {
			pArgmaxWhenWrong.push(probs[argmax]!)
			confusedFor[argmaxLabel] = (confusedFor[argmaxLabel] ?? 0) + 1
		}
	}
	const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
	const acc = (100 * correct) / located
	const meanPc = mean(pCorrectAll)
	const meanPwrong = mean(pArgmaxWhenWrong)
	const top = Object.entries(confusedFor)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([l, c]) => `${l} ${((100 * c) / pArgmaxWhenWrong.length || 0).toFixed(0)}%`)
		.join(", ")
	// Heuristic read: confidently-wrong (signal) when the model is mostly wrong AND, when wrong, very
	// sure of the wrong tag. High-entropy (capacity) when the wrong mass is smeared (low argmax prob).
	let verdict: string

	if (acc >= 80) {
		verdict = "✓ mostly right (not the bottleneck)"
	} else if (meanPwrong >= 0.6) {
		verdict = "SIGNAL — confidently wrong → augmentation can flip it"
	} else if (meanPwrong < 0.5) {
		verdict = "CAPACITY — high-entropy/uncertain → wants a bigger model"
	} else {
		verdict = "MIXED — partly confident, partly smeared"
	}
	console.log(`\n## ${template}  (probe: B-${tag}, ${why})`)
	console.log(`  located ${located}/${N}  ·  boundary acc ${acc.toFixed(1)}%  ·  mean P(correct) ${meanPc.toFixed(3)}`)
	console.log(
		`  when WRONG: mean P(argmax) ${Number.isNaN(meanPwrong) ? "n/a" : meanPwrong.toFixed(3)}  ·  confused for: ${top || "n/a"}`
	)
	console.log(`  → ${verdict}`)
}
console.log()
