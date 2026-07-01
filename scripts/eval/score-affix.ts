import { readFileSync } from "node:fs"

// Affix-aware per-tag scorer. per-locale-f1's foldToComponents joins street_prefix+street+street_suffix
// into one `street`, so it CANNOT measure the affix split. This scores the UNFOLDED decodeAsJSON
// output against split ground truth: exact-match (case-insensitive) P/R/F1 per tag.
// Usage: node --experimental-strip-types scripts/eval/score-affix.ts --model <onnx> [--file <jsonl>]
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"

import { arg } from "../lib/cli-args.ts"

const argv = process.argv.slice(2)
const TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
const LK = dataRootPath("anchor", "pilot-anchor-lookup.json")
const file = arg("file", "data/eval/external/street-affix-real.jsonl")!
const TAGS = [
	"street_prefix",
	"street",
	"street_suffix",
	"house_number",
	"locality",
	"region",
	"postcode",
	"unit",
	"intersection_a",
	"intersection_b",
	"po_box",
	"cedex",
] as const

// A gazetteer-trained model MUST be fed the lexicon (+ the paired postcode suppression) at inference,
// else the zero-filled clue is a train/inference mismatch that wrecks segmentation. Pass for v1.0.0+.
const GAZ = arg("gazetteer-lexicon")
const suppressGaz = argv.includes("--suppress-gaz-near-postcode")

const card = JSON.parse(readFileSync("neural-weights-en-us/model-card.json", "utf8"))
const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), ONNXRunner.create(arg("model")!)])
const neural = new NeuralAddressClassifier({
	tokenizer,
	runner,
	labels: card.labels,
	postcodeAnchorLookup: parseAnchorLookup(JSON.parse(readFileSync(LK, "utf8"))),
	...(GAZ ? { gazetteerLexicon: parseGazetteerLexicon(JSON.parse(readFileSync(GAZ, "utf8"))) } : {}),
	suppressGazetteerNearPostcode: suppressGaz,
	// #511 Tier A: --conventions auto|<system> enables the address-system conventions mask.
	...(arg("conventions") ? { addressSystemConventions: arg("conventions") as "auto" } : {}),
	// v4.4.0 corrective: --bridge-gaps merges same-tag spans split at unlabeled punctuation.
	...(argv.includes("--bridge-gaps") ? { bridgePunctuationGaps: true } : {}),
})

const rows = readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l))
const norm = (s?: string) => (s ?? "").trim().toLowerCase()
const stat: Record<string, { tp: number; fp: number; fn: number }> = {}

for (const t of TAGS) stat[t] = { tp: 0, fp: 0, fn: 0 }

for (const row of rows) {
	const got = decodeAsJSON(await neural.parse(row.raw)) as Record<string, string>
	const exp = row.components as Record<string, string>

	for (const t of TAGS) {
		const e = norm(exp[t]),
			g = norm(got[t])

		if (e && g && e === g) stat[t]!.tp++
		else {
			if (g) stat[t]!.fp++

			if (e) stat[t]!.fn++
		}
	}
}
console.log(`# affix per-tag (unfolded) — ${arg("model")!.split("/").slice(-2).join("/")} · n=${rows.length}`)
console.log("| tag | P | R | F1 | tp/fp/fn |\n| --- | --: | --: | --: | --- |")
const sidecar: Record<string, { p: number; r: number; f1: number; tp: number; fp: number; fn: number }> = {}

for (const t of TAGS) {
	const { tp, fp, fn } = stat[t]!
	const p = tp + fp ? tp / (tp + fp) : 0
	const r = tp + fn ? tp / (tp + fn) : 0
	const f1 = p + r ? (2 * p * r) / (p + r) : 0
	sidecar[t] = { p: +(100 * p).toFixed(1), r: +(100 * r).toFixed(1), f1: +(100 * f1).toFixed(1), tp, fp, fn }
	console.log(
		`| ${t} | ${(100 * p).toFixed(1)} | ${(100 * r).toFixed(1)} | ${(100 * f1).toFixed(1)} | ${tp}/${fp}/${fn} |`
	)
}
// JSON sidecar (--json <path>): the machine-readable contract the gate verdict reads — the
// markdown above is presentation. Codex-review follow-up: regex-parsing scorer tables was the
// gate's one brittle joint.
const jsonOut = arg("json")

if (jsonOut) {
	const { writeFileSync } = await import("node:fs")
	writeFileSync(jsonOut, JSON.stringify({ n: rows.length, file, tags: sidecar }, null, "\t") + "\n")
}
