import { readFileSync } from "node:fs"

// One-off (#478 slice 2 evidence): does the SHIPPED v4.3.0 model emit US-convention tags on
// DE/GB-shaped rows (the cross-locale leakage class the fr conventions row fixed for French)?
// Counts affix-tag emissions + postcode-shape violations per locale slice, WITHOUT the
// conventions mask (the shipped default for undetected/unmasked systems) — the evidence a
// `de`/`gb` conventions row needs before it exists (no rows from vibes).
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"

const TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
const LK = dataRootPath("anchor", "pilot-anchor-lookup.json")
const card = JSON.parse(readFileSync("neural-weights-en-us/model-card.json", "utf8"))
const [tokenizer, runner] = await Promise.all([
	MailwomanTokenizer.loadFromFile(TOK),
	ONNXRunner.create("/tmp/v110-relabel-40k-locale-int8.onnx"),
])
const neural = new NeuralAddressClassifier({
	tokenizer,
	runner,
	labels: card.labels,
	postcodeAnchorLookup: parseAnchorLookup(JSON.parse(readFileSync(LK, "utf8"))),
	gazetteerLexicon: parseGazetteerLexicon(JSON.parse(readFileSync("data/gazetteer/anchor-lexicon-v1.json", "utf8"))),
	suppressGazetteerNearPostcode: true,
})

const slices: Array<[string, string, number]> = [
	["DE native", "data/eval/external/openaddresses-de-sample-native-order.jsonl", 300],
	["DE intl", "data/eval/external/openaddresses-de-sample.jsonl", 300],
]

for (const [label, file, cap] of slices) {
	const rows = readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.slice(0, cap)
		.map((l) => JSON.parse(l))
	let affix = 0
	let badPostcode = 0
	let n = 0
	const samples: string[] = []

	for (const row of rows) {
		n++
		const text = row.raw ?? row.input
		const got = decodeAsJSON(await neural.parse(text)) as Record<string, string>

		if (got.street_prefix || got.street_suffix) {
			affix++

			if (samples.length < 4)
				samples.push(`${text.slice(0, 60)} → prefix="${got.street_prefix ?? ""}" suffix="${got.street_suffix ?? ""}"`)
		}

		// DE postcodes are exactly 5 digits (same shape as FR).
		if (got.postcode && !/^\d{5}$/.test(got.postcode.trim())) {
			badPostcode++

			if (samples.length < 6) samples.push(`${text.slice(0, 60)} → postcode="${got.postcode}"`)
		}
	}
	console.log(`\n== ${label} (n=${n}) ==`)
	console.log(
		`affix-tag emissions: ${affix} (${((100 * affix) / n).toFixed(1)}%) · postcode-shape violations: ${badPostcode} (${((100 * badPostcode) / n).toFixed(1)}%)`
	)

	for (const s of samples) console.log(`  ${s}`)
}
