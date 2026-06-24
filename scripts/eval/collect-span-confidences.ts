/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stage 2 of the confidence-calibration pipeline (task #59). Runs the SHIPPED model over the
 *   calibration set (`build-calibration-set.py`) and emits one record per PREDICTED span pairing
 *   its raw softmax confidence with a correct/incorrect label — the `(score, correct?)` pairs the
 *   isotonic fitter (`fit-isotonic-calibration.py`) consumes.
 *
 *   Calibration is over PREDICTIONS (spans the model emitted), conditioning on "the model said tag T
 *   at confidence C — how often is it right?". So we iterate the decoded tree's spans, not the
 *   gold.
 *
 *   The span confidence is the decoder's own per-node value (`AddressNode.confidence`, the mean of
 *   the span's per-token softmax probabilities — `core/decoder/build-tree.ts`). That is exactly the
 *   `conf=` a resolver or a human reads off the XML, so it is the right quantity to calibrate — not
 *   the raw per-token probability the older `probe-confidence.ts` bucketed.
 *
 *   The model is constructed exactly as `oa-resolver-eval.ts` builds it (same parseOpts), so the
 *   confidences match the canonical eval path.
 *
 *   Matching (`correct?`):
 *
 *   - OA rows (`partial:true`) grade ONLY {locality, region, postcode} — the tags OA gold carries. A
 *       predicted tag OA can't see is unlabelable and skipped (OA's silence is not a negative).
 *   - Corpus rows (`partial:false`) grade every predicted span against the full BIO gold; a predicted
 *       tag the address lacks is a hallucination → wrong.
 *   - The street family {street, street_prefix, street_suffix} is one equivalence class so the model's
 *       street decomposition isn't penalized against the corpus's coarse `street` gold.
 *   - Value match is normalized exact OR either-direction substring (handles fragmentation like "Saint"
 *       vs "Saint Paul" and decomposition like "Ave" vs "Elm Ave").
 *
 *   Run: node --experimental-strip-types scripts/eval/collect-span-confidences.ts\
 *   --model neural-weights-en-us/model.onnx\
 *   --tokenizer neural-weights-en-us/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json\
 *   --set data/eval/calibration/calibration-set.jsonl\
 *   --out data/eval/calibration/confidences.jsonl
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { readFileSync, writeFileSync } from "node:fs"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

interface CalibRow {
	raw: string
	gold: [string, string][]
	country: string
	source: "oa" | "corpus"
	partial: boolean
}

interface ConfRecord {
	conf: number
	correct: boolean
	tag: string
	country: string
	source: "oa" | "corpus"
}

const STREET_FAMILY = new Set(["street", "street_prefix", "street_suffix"])
const OA_GRADABLE = new Set(["locality", "region", "postcode"])

/** Collapse the street decomposition into one matching class; everything else maps to itself. */
function tagClass(tag: string): string {
	return STREET_FAMILY.has(tag) ? "street" : tag
}

/** Lowercase, strip non-alphanumeric (unicode-aware) to single spaces, collapse + trim. */
function norm(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ")
}

/**
 * Normalized exact, or either-direction TOKEN-subset (fragmentation + decomposition tolerant).
 * Token subset, not raw substring, so "Saint" ⊆ "Saint Paul" and "Ave" ⊆ "Elm Ave" match while
 * "Park" does NOT spuriously match "Parkway".
 */
function valueMatch(pred: string, gold: string): boolean {
	const a = norm(pred)
	const b = norm(gold)
	if (!a || !b) return false
	if (a === b) return true
	const at = a.split(" ")
	const bt = b.split(" ")
	const aset = new Set(at)
	const bset = new Set(bt)
	const subset = (xs: string[], ys: Set<string>): boolean => xs.every((t) => ys.has(t))
	return subset(at, bset) || subset(bt, aset)
}

/** Flatten the decoded tree to a list of (tag, value, confidence) spans. */
function flattenSpans(tree: AddressTree): { tag: string; value: string; conf: number }[] {
	const out: { tag: string; value: string; conf: number }[] = []
	const walk = (n: AddressNode): void => {
		out.push({ tag: n.tag, value: n.value, conf: n.confidence })
		for (const c of n.children) walk(c)
	}
	for (const r of tree.roots) walk(r)
	return out
}

/**
 * Grade one predicted span against a row's gold. Returns `null` when the span is unlabelable (OA
 * can't see this tag), else `true`/`false`.
 */
function gradeSpan(predTag: string, predValue: string, row: CalibRow): boolean | null {
	if (row.partial) {
		if (!OA_GRADABLE.has(predTag)) return null
		const goldVals = row.gold.filter(([t]) => t === predTag).map(([, v]) => v)
		if (goldVals.length === 0) return null // OA row lacks this tag entirely → unlabelable
		return goldVals.some((g) => valueMatch(predValue, g))
	}
	const cls = tagClass(predTag)
	const goldVals = row.gold.filter(([t]) => tagClass(t) === cls).map(([, v]) => v)
	if (goldVals.length === 0) return false // hallucinated tag the address doesn't have
	return goldVals.some((g) => valueMatch(predValue, g))
}

async function main(): Promise<void> {
	const setPath = arg("set", "data/eval/calibration/calibration-set.jsonl")
	const outPath = arg("out", "data/eval/calibration/confidences.jsonl")
	const limit = Number(arg("limit", "0")) || Infinity

	const rows: CalibRow[] = readFileSync(setPath, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l))
		.slice(0, limit === Infinity ? undefined : limit)

	const { NeuralAddressClassifier } = await import("@mailwoman/neural")
	const { OnnxRunner } = await import("@mailwoman/neural/onnx-runner")
	const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")
	const modelCard = JSON.parse(readFileSync(arg("model-card", "neural-weights-en-us/model-card.json"), "utf8"))
	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(arg("tokenizer", "neural-weights-en-us/tokenizer.model")),
		OnnxRunner.create(arg("model", "neural-weights-en-us/model.onnx")),
	])
	// Ship-config channels (v4.4.0): the calibrator must describe the model AS DEPLOYED — anchor +
	// gazetteer (+ suppression), conventions, and the span bridge all change span confidences.
	const { parseAnchorLookup, parseGazetteerLexicon } = await import("@mailwoman/neural")
	const anchorPath = arg("anchor-lookup", "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json")
	const gazPath = arg("gazetteer-lexicon", "data/gazetteer/anchor-lexicon-v1.json")
	const neural = new NeuralAddressClassifier({
		tokenizer,
		runner,
		labels: modelCard.labels,
		postcodeAnchorLookup: parseAnchorLookup(JSON.parse(readFileSync(anchorPath, "utf8"))),
		gazetteerLexicon: parseGazetteerLexicon(JSON.parse(readFileSync(gazPath, "utf8"))),
		suppressGazetteerNearPostcode: true,
		addressSystemConventions: "auto",
		bridgePunctuationGaps: true,
	})
	const parseOpts = { postcodeRepair: true } as Parameters<typeof neural.parse>[1]

	const records: ConfRecord[] = []
	let unlabelable = 0
	let i = 0
	for (const row of rows) {
		i++
		if (i % 1000 === 0) console.error(`  ${i}/${rows.length}  (${records.length} gradable spans)`)
		// onnxruntime-node accumulates native tensor memory across runs faster than JS GC reclaims it
		// (~380-parse SIGKILL on the lab box). Periodic forced GC reclaims it; run with `node
		// --expose-gc` for full calibration sets (8000 rows). No-op without the flag. (#787 pattern.)
		if (i % 50 === 0) (globalThis as { gc?: () => void }).gc?.()
		let tree: AddressTree
		try {
			tree = await neural.parse(row.raw, parseOpts)
		} catch {
			continue
		}
		for (const span of flattenSpans(tree)) {
			const correct = gradeSpan(span.tag, span.value, row)
			if (correct === null) {
				unlabelable++
				continue
			}
			records.push({ conf: span.conf, correct, tag: span.tag, country: row.country, source: row.source })
		}
	}

	writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n")
	const n = records.length
	const acc = records.filter((r) => r.correct).length / n
	const meanConf = records.reduce((a, r) => a + r.conf, 0) / n
	const byOa = records.filter((r) => r.source === "oa")
	const byCorpus = records.filter((r) => r.source === "corpus")
	console.error(`\nwrote ${n} gradable spans → ${outPath}  (${unlabelable} unlabelable skipped)`)
	console.error(
		`  overall: acc=${acc.toFixed(4)}  meanConf=${meanConf.toFixed(4)}  gap(conf-acc)=${(meanConf - acc).toFixed(4)}`
	)
	console.error(`  OA spans=${byOa.length}  corpus spans=${byCorpus.length}`)
}

void main()
