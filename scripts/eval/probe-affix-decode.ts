// Probe: does a model emit street_prefix/street_suffix in the RAW (unfolded) decode?
// per-locale-f1's foldToComponents joins prefix+street+suffix into one `street`, hiding the split.
// This prints decodeAsJson(tree) verbatim so we can see what the model actually tags.
// Usage: node --experimental-strip-types scripts/eval/probe-affix-decode.ts --model <onnx> [--file <jsonl>]
import { decodeAsJson } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier, parseAnchorLookup } from "@mailwoman/neural"
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

const card = JSON.parse(readFileSync("neural-weights-en-us/model-card.json", "utf8"))
const [tokenizer, runner] = await Promise.all([
	MailwomanTokenizer.loadFromFile(TOK),
	OnnxRunner.create(arg("--model")!),
])
const postcodeAnchorLookup = parseAnchorLookup(JSON.parse(readFileSync(LK, "utf8")))
const neural = new NeuralAddressClassifier({ tokenizer, runner, labels: card.labels, postcodeAnchorLookup })

const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
let prefixHits = 0,
	suffixHits = 0
for (const row of rows.slice(0, 10)) {
	const tree = await neural.parse(row.raw)
	const got = decodeAsJson(tree) as Record<string, string>
	const aff = ["street_prefix", "street", "street_suffix"].filter((t) => got[t]).map((t) => `${t}=${got[t]!}`)
	if (got.street_prefix) prefixHits++
	if (got.street_suffix) suffixHits++
	console.log(`${row.raw}\n   → ${aff.join(" · ") || "(no street tags)"}`)
}
console.log(`\nstreet_prefix emitted in ${prefixHits}/10, street_suffix in ${suffixHits}/10`)
