// Affix-aware per-tag scorer. per-locale-f1's foldToComponents joins street_prefix+street+street_suffix
// into one `street`, so it CANNOT measure the affix split. This scores the UNFOLDED decodeAsJson
// output against split ground truth: exact-match (case-insensitive) P/R/F1 per tag.
// Usage: node --experimental-strip-types scripts/eval/score-affix.ts --model <onnx> [--file <jsonl>]
import { decodeAsJson } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { readFileSync } from "node:fs"

const argv = process.argv.slice(2)
const arg = (k: string, d?: string) => {
	const i = argv.indexOf(k)
	return i >= 0 ? argv[i + 1] : d
}
const TOK = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const LK = "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"
const file = arg("--file", "data/eval/external/street-affix-real.jsonl")!
const TAGS = ["street_prefix", "street", "street_suffix", "house_number", "locality", "region", "postcode", "unit"] as const

// A gazetteer-trained model MUST be fed the lexicon (+ the paired postcode suppression) at inference,
// else the zero-filled clue is a train/inference mismatch that wrecks segmentation. Pass for v1.0.0+.
const GAZ = arg("--gazetteer-lexicon")
const suppressGaz = argv.includes("--suppress-gaz-near-postcode")

const card = JSON.parse(readFileSync("neural-weights-en-us/model-card.json", "utf8"))
const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), OnnxRunner.create(arg("--model")!)])
const neural = new NeuralAddressClassifier({
	tokenizer,
	runner,
	labels: card.labels,
	postcodeAnchorLookup: parseAnchorLookup(JSON.parse(readFileSync(LK, "utf8"))),
	...(GAZ ? { gazetteerLexicon: parseGazetteerLexicon(JSON.parse(readFileSync(GAZ, "utf8"))) } : {}),
	suppressGazetteerNearPostcode: suppressGaz,
})

const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const norm = (s?: string) => (s ?? "").trim().toLowerCase()
const stat: Record<string, { tp: number; fp: number; fn: number }> = {}
for (const t of TAGS) stat[t] = { tp: 0, fp: 0, fn: 0 }

for (const row of rows) {
	const got = decodeAsJson(await neural.parse(row.raw)) as Record<string, string>
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
console.log(`# affix per-tag (unfolded) — ${arg("--model")!.split("/").slice(-2).join("/")} · n=${rows.length}`)
console.log("| tag | P | R | F1 | tp/fp/fn |\n| --- | --: | --: | --: | --- |")
for (const t of TAGS) {
	const { tp, fp, fn } = stat[t]!
	const p = tp + fp ? tp / (tp + fp) : 0
	const r = tp + fn ? tp / (tp + fn) : 0
	const f1 = p + r ? (2 * p * r) / (p + r) : 0
	console.log(`| ${t} | ${(100 * p).toFixed(1)} | ${(100 * r).toFixed(1)} | ${(100 * f1).toFixed(1)} | ${tp}/${fp}/${fn} |`)
}
