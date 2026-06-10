// Country homograph scorer — the TRUE baseline for the model-first country lever.
// Measures country/region/locality P/R/F1 (unfolded decodeAsJson) on the hard homograph eval,
// PLUS the over-fire confusion: how often a gold region/locality span is mistagged as `country`
// (the "trailing token = country" failure), and how often gold country is missed.
// Usage: node --experimental-strip-types scripts/eval/score-country-homograph.ts --model <onnx> [--file <jsonl>]
import { decodeAsJson } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { existsSync, readFileSync } from "node:fs"

const argv = process.argv.slice(2)
const arg = (k: string, d?: string) => {
	const i = argv.indexOf(k)
	return i >= 0 ? argv[i + 1] : d
}
const TOK = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const LK = "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"
// Gazetteer-anchor lexicon (#464): fed when present so a gazetteer-trained model (v0.9.12+) gets its
// candidate-tag clues; harmless for older models (the runner skips inputs the ONNX doesn't declare).
const GAZ = arg("--gazetteer-lexicon", "data/gazetteer/anchor-lexicon-v1.json")!
const file = arg("--file", "data/eval/external/country-homograph-real.jsonl")!
const TAGS = ["country", "region", "locality"] as const

const card = JSON.parse(readFileSync("neural-weights-en-us/model-card.json", "utf8"))
const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), OnnxRunner.create(arg("--model")!)])
const neural = new NeuralAddressClassifier({
	tokenizer,
	runner,
	labels: card.labels,
	postcodeAnchorLookup: parseAnchorLookup(JSON.parse(readFileSync(LK, "utf8"))),
	...(existsSync(GAZ) ? { gazetteerLexicon: parseGazetteerLexicon(JSON.parse(readFileSync(GAZ, "utf8"))) } : {}),
	suppressGazetteerNearPostcode: argv.includes("--suppress-gaz-near-postcode"),
	// #511 Tier A: --conventions auto|<system> enables the address-system conventions mask.
	...(arg("--conventions") ? { addressSystemConventions: arg("--conventions") as "auto" } : {}),
})

const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const norm = (s?: string) => (s ?? "").trim().toLowerCase()
const stat: Record<string, { tp: number; fp: number; fn: number }> = {}
for (const t of TAGS) stat[t] = { tp: 0, fp: 0, fn: 0 }

// over-fire diagnostics
let overfire = 0 // gold region/locality token tagged as country
let missedCountry = 0 // gold country present, model emitted no country
const overfireCases: string[] = []
const missedCases: string[] = []

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
	// over-fire: model emitted a country that is actually the gold region or locality
	const gc = norm(got.country)
	if (gc && !norm(exp.country) && (gc === norm(exp.region) || gc === norm(exp.locality))) {
		overfire++
		overfireCases.push(`  ${row.raw}  → country="${got.country}" (gold ${norm(exp.region) === gc ? "region" : "locality"})`)
	}
	if (norm(exp.country) && !gc) {
		missedCountry++
		missedCases.push(`  ${row.raw}  → no country emitted (gold "${exp.country}")`)
	}
}

console.log(`# country homograph baseline — ${arg("--model")!.split("/").slice(-1)[0]} · n=${rows.length}`)
console.log("| tag | P | R | F1 | tp/fp/fn |\n| --- | --: | --: | --: | --- |")
for (const t of TAGS) {
	const { tp, fp, fn } = stat[t]!
	const p = tp + fp ? tp / (tp + fp) : 0
	const r = tp + fn ? tp / (tp + fn) : 0
	const f1 = p + r ? (2 * p * r) / (p + r) : 0
	console.log(`| ${t} | ${(100 * p).toFixed(1)} | ${(100 * r).toFixed(1)} | ${(100 * f1).toFixed(1)} | ${tp}/${fp}/${fn} |`)
}
console.log(`\nover-fire (region/locality tagged as country): ${overfire}`)
console.log(`missed country (gold country, none emitted): ${missedCountry}`)
if (overfireCases.length) console.log("\n-- over-fire cases --\n" + overfireCases.join("\n"))
if (missedCases.length) console.log("\n-- missed-country cases --\n" + missedCases.join("\n"))
