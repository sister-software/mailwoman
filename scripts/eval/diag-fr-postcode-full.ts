// One-off (#511): full parse dumps for the 6 FR-postcode gate misses, v1.1.0 vs shipped v4.2.0.
import { decodeAsJson } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { readFileSync } from "node:fs"

const TOK = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const LK = "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"
const card = JSON.parse(readFileSync("neural-weights-en-us/model-card.json", "utf8"))
const tokenizer = await MailwomanTokenizer.loadFromFile(TOK)

async function classifier(model: string) {
	return new NeuralAddressClassifier({
		tokenizer,
		runner: await OnnxRunner.create(model),
		labels: card.labels,
		postcodeAnchorLookup: parseAnchorLookup(JSON.parse(readFileSync(LK, "utf8"))),
		gazetteerLexicon: parseGazetteerLexicon(JSON.parse(readFileSync("data/gazetteer/anchor-lexicon-v1.json", "utf8"))),
		suppressGazetteerNearPostcode: true,
	})
}

const v110 = await classifier("/tmp/v110-relabel-040000.onnx")
const v420 = await classifier("/tmp/v102-runB-fp32.onnx")

const rows = readFileSync("data/eval/golden/v0.1.2/dev/fr.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const targets = ["47110 Sainte-Livrade-sur-Lot, 72 Rossignol 3", "47110 Sainte-Livrade-sur-Lot 6 Rue d'Agen", "02870 Crépy, France", "07430 Davézieux", "Case Postale 200, H3A 1B9 Montréal, QC", "CP 1500, H2X 3V4 Montréal, QC"]

for (const t of targets) {
	const row = rows.find((r) => r.raw === t)
	if (!row) { console.log(`NOT FOUND: ${t}`); continue }
	console.log(`\n=== "${row.raw}"`)
	console.log(`  gold:   ${JSON.stringify(row.components)}`)
	console.log(`  v1.1.0: ${JSON.stringify(decodeAsJson(await v110.parse(row.raw)))}`)
	console.log(`  v4.2.0: ${JSON.stringify(decodeAsJson(await v420.parse(row.raw)))}`)
}
