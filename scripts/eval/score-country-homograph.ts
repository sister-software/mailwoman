import { existsSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"

// Country homograph scorer — the TRUE baseline for the model-first country lever.
// Measures country/region/locality P/R/F1 (unfolded decodeAsJSON) on the hard homograph eval,
// PLUS the over-fire confusion: how often a gold region/locality span is mistagged as `country`
// (the "trailing token = country" failure), and how often gold country is missed.
// Usage: node --experimental-strip-types scripts/eval/score-country-homograph.ts --model <onnx> [--file <jsonl>]
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"

// Loose scan parity with the retired scripts/lib/cli-args helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: {
		conventions: { type: "string" },
		file: { type: "string" },
		"gazetteer-lexicon": { type: "string" },
		json: { type: "string" },
		model: { type: "string" },
	},
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as {
	conventions?: string
	file?: string
	"gazetteer-lexicon"?: string
	json?: string
	model?: string
}
const argv = process.argv.slice(2)
const TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
const LK = dataRootPath("anchor", "pilot-anchor-lookup.json")
// Gazetteer-anchor lexicon (#464): fed when present so a gazetteer-trained model (v0.9.12+) gets its
// candidate-tag clues; harmless for older models (the runner skips inputs the ONNX doesn't declare).
const GAZ = (values["gazetteer-lexicon"] || "data/gazetteer/anchor-lexicon-v1.json")!
const file = (values["file"] || "data/eval/external/country-homograph-real.jsonl")!
const TAGS = ["country", "region", "locality"] as const

const card = JSON.parse(readFileSync("neural-weights-en-us/model-card.json", "utf8"))
const [tokenizer, runner] = await Promise.all([
	MailwomanTokenizer.loadFromFile(TOK),
	ONNXRunner.create((values["model"] || "")!),
])
const neural = new NeuralAddressClassifier({
	tokenizer,
	runner,
	labels: card.labels,
	postcodeAnchorLookup: parseAnchorLookup(JSON.parse(readFileSync(LK, "utf8"))),
	...(existsSync(GAZ) ? { gazetteerLexicon: parseGazetteerLexicon(JSON.parse(readFileSync(GAZ, "utf8"))) } : {}),
	suppressGazetteerNearPostcode: argv.includes("--suppress-gaz-near-postcode"),
	// #511 Tier A: --conventions auto|<system> enables the address-system conventions mask.
	...(values["conventions"] || "" ? { addressSystemConventions: (values["conventions"] || "") as "auto" } : {}),
	...(argv.includes("--bridge-gaps") ? { bridgePunctuationGaps: true } : {}),
})

const rows = readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l))
const norm = (s?: string) => (s ?? "").trim().toLowerCase()
const stat: Record<string, { tp: number; fp: number; fn: number }> = {}

for (const t of TAGS) {
	stat[t] = { tp: 0, fp: 0, fn: 0 }
}

// over-fire diagnostics
let overfire = 0 // gold region/locality token tagged as country
let missedCountry = 0 // gold country present, model emitted no country
const overfireCases: string[] = []
const missedCases: string[] = []

for (const row of rows) {
	const got = decodeAsJSON(await neural.parse(row.raw)) as Record<string, string>
	const exp = row.components as Record<string, string>

	for (const t of TAGS) {
		const e = norm(exp[t]),
			g = norm(got[t])

		if (e && g && e === g) {
			stat[t]!.tp++
		} else {
			if (g) {
				stat[t]!.fp++
			}

			if (e) {
				stat[t]!.fn++
			}
		}
	}
	// over-fire: model emitted a country that is actually the gold region or locality
	const gc = norm(got.country)

	if (gc && !norm(exp.country) && (gc === norm(exp.region) || gc === norm(exp.locality))) {
		overfire++
		overfireCases.push(
			`  ${row.raw}  → country="${got.country}" (gold ${norm(exp.region) === gc ? "region" : "locality"})`
		)
	}

	if (norm(exp.country) && !gc) {
		missedCountry++
		missedCases.push(`  ${row.raw}  → no country emitted (gold "${exp.country}")`)
	}
}

console.log(`# country homograph baseline — ${(values["model"] || "")!.split("/").slice(-1)[0]} · n=${rows.length}`)
const sidecar: Record<string, { p: number; r: number; f1: number; tp: number; fp: number; fn: number }> = {}
console.log("| tag | P | R | F1 | tp/fp/fn |\n| --- | --: | --: | --: | --- |")

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
// JSON sidecar — the machine-readable contract for the gate verdict (markdown = presentation).
const jsonOut = values["json"] || ""

if (jsonOut) {
	const { writeFileSync } = await import("node:fs")
	writeFileSync(
		jsonOut,
		JSON.stringify({ n: rows.length, file, tags: sidecar, overfire, missedCountry }, null, "\t") + "\n"
	)
}
console.log(`\nover-fire (region/locality tagged as country): ${overfire}`)
console.log(`missed country (gold country, none emitted): ${missedCountry}`)

if (overfireCases.length) {
	console.log("\n-- over-fire cases --\n" + overfireCases.join("\n"))
}

if (missedCases.length) {
	console.log("\n-- missed-country cases --\n" + missedCases.join("\n"))
}
