import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

// Probe: does a model emit street_prefix/street_suffix in the RAW (unfolded) decode?
// per-locale-f1's foldToComponents joins prefix+street+suffix into one `street`, hiding the split.
// This prints decodeAsJSON(tree) verbatim so we can see what the model actually tags.
// Usage: node --experimental-strip-types scripts/eval/probe-affix-decode.ts --model <onnx> [--file <jsonl>]
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier, parseAnchorLookup } from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"

// Loose scan parity with the retired scripts/lib/cli-args helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: { file: { type: "string" }, model: { type: "string" } },
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as { file?: string; model?: string }
const argv = process.argv.slice(2)
const TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
const LK = dataRootPath("anchor", "pilot-anchor-lookup.json")
const file = (values["file"] || "data/eval/external/street-affix-real.jsonl")!

const card = JSON.parse(readFileSync("neural-weights-en-us/model-card.json", "utf8"))
const [tokenizer, runner] = await Promise.all([
	MailwomanTokenizer.loadFromFile(TOK),
	ONNXRunner.create((values["model"] || "")!),
])
const postcodeAnchorLookup = parseAnchorLookup(JSON.parse(readFileSync(LK, "utf8")))
const neural = new NeuralAddressClassifier({ tokenizer, runner, labels: card.labels, postcodeAnchorLookup })

const rows = readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l))
let prefixHits = 0,
	suffixHits = 0

for (const row of rows.slice(0, 10)) {
	const tree = await neural.parse(row.raw)
	const got = decodeAsJSON(tree) as Record<string, string>
	const aff = ["street_prefix", "street", "street_suffix"].filter((t) => got[t]).map((t) => `${t}=${got[t]!}`)

	if (got.street_prefix) {
		prefixHits++
	}

	if (got.street_suffix) {
		suffixHits++
	}
	console.log(`${row.raw}\n   → ${aff.join(" · ") || "(no street tags)"}`)
}
console.log(`\nstreet_prefix emitted in ${prefixHits}/10, street_suffix in ${suffixHits}/10`)
