import { decodeAsJson } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { readFileSync } from "node:fs"

const TOK = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const LK = "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"
const card = JSON.parse(readFileSync("neural-weights-en-us/model-card.json", "utf8"))
const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), OnnxRunner.create("/tmp/v110-relabel-040000.onnx")])
const neural = new NeuralAddressClassifier({
	tokenizer, runner, labels: card.labels,
	postcodeAnchorLookup: parseAnchorLookup(JSON.parse(readFileSync(LK, "utf8"))),
	gazetteerLexicon: parseGazetteerLexicon(JSON.parse(readFileSync("data/gazetteer/anchor-lexicon-v1.json", "utf8"))),
	suppressGazetteerNearPostcode: true,
})
const rows = readFileSync("data/eval/golden/v0.1.2/dev/fr.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const norm = (s?: string) => (s ?? "").trim().toLowerCase()
let n = 0
for (const row of rows) {
	const gold = norm(row.components?.postcode)
	if (!gold) continue
	const got = decodeAsJson(await neural.parse(row.raw)) as Record<string, string>
	if (norm(got.postcode) !== gold) {
		n++
		console.log(`✗ gold="${gold}" got="${norm(got.postcode) || "(nothing)"}" street="${norm(got.street)}" · ${row.raw}`)
	}
}
console.log(`total FR postcode misses: ${n}`)
