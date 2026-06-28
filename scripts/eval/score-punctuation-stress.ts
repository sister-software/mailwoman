import { readFileSync, writeFileSync } from "node:fs"

// Per-class scorer for the punctuation-stress eval (#518). Grades EVERY component key present in
// each row's gold (exact match, case-insensitive) and reports per-class component accuracy plus
// parse SURVIVAL (a thrown parse fails every component in its row — the unbalanced-delimiter
// classes exist to measure exactly that). Conventions: punctuation-stress.README.md.
//
// --engine v0 grades the legacy rules parser on the FOLDED view of the same gold: v0's vocabulary
// has no street_prefix/street_suffix (joined into street, the harness fold convention) and no
// cedex (excluded from its denominator) — each engine is graded on its own vocabulary's view of
// identical gold, stated in the report header.
// Usage: node --experimental-strip-types scripts/eval/score-punctuation-stress.ts --model <onnx>
//   [--engine neural|v0] [--file data/eval/external/punctuation-stress.jsonl] [--no-ship-config]
//   [--span-proposer]  — enable the Stage 2.7 span proposer (#518 M2+M3; default-off, NOT ship config)
import { decodeAsJson } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import {
	buildCodexSpanLexicon,
	NeuralAddressClassifier,
	parseAnchorLookup,
	parseGazetteerLexicon,
} from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { createAddressParser } from "mailwoman"

import { arg } from "../lib/cli-args.ts"

const argv = process.argv.slice(2)
const TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
const LK = dataRootPath("anchor", "pilot-anchor-lookup.json")
const file = arg("file", "data/eval/external/punctuation-stress.jsonl")!

const engine = arg("engine", "neural")!

const card = JSON.parse(readFileSync("neural-weights-en-us/model-card.json", "utf8"))
const [tokenizer, runner] =
	engine === "neural"
		? await Promise.all([MailwomanTokenizer.loadFromFile(TOK), OnnxRunner.create(arg("model")!)])
		: [undefined!, undefined!]
const shipConfig = !argv.includes("--no-ship-config")
const v0 = engine === "v0" ? createAddressParser() : undefined
const neural =
	engine === "v0"
		? undefined!
		: new NeuralAddressClassifier({
				tokenizer,
				runner,
				labels: card.labels,
				postcodeAnchorLookup: parseAnchorLookup(JSON.parse(readFileSync(LK, "utf8"))),
				...(shipConfig
					? {
							gazetteerLexicon: parseGazetteerLexicon(
								JSON.parse(readFileSync(arg("gazetteer-lexicon", "data/gazetteer/anchor-lexicon-v1.json")!, "utf8"))
							),
							suppressGazetteerNearPostcode: true,
							addressSystemConventions: "auto" as const,
							bridgePunctuationGaps: true,
						}
					: {}),
				...(argv.includes("--span-proposer")
					? {
							spanProposer: {
								lexicon: buildCodexSpanLexicon(),
								...(arg("sp-bias") ? { biasScale: +arg("sp-bias")! } : {}),
								...(arg("sp-ann-bias") ? { annotationBiasScale: +arg("sp-ann-bias")! } : {}),
							},
						}
					: {}),
			})

interface Row {
	raw: string
	components: Record<string, string>
	class: string
}
const rows: Row[] = readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l))
const norm = (s?: string) => (s ?? "").trim().toLowerCase()

/** V0-vocabulary view of a gold record: affixes fold into street; cedex is out of vocab. */
function foldGoldForV0(components: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {}
	const street = ["street_prefix", "street", "street_suffix"]
		.map((t) => components[t])
		.filter(Boolean)
		.join(" ")

	for (const [tag, v] of Object.entries(components)) {
		if (tag === "cedex" || tag === "street_prefix" || tag === "street_suffix") continue
		out[tag] = tag === "street" ? street : v
	}

	if (street && !out.street) out.street = street

	return out
}

async function parseWith(raw: string): Promise<Record<string, string>> {
	if (engine === "v0") {
		const solutions = await v0!.parse(raw)
		const rec = (solutions[0]?.classifications ?? {}) as Record<string, string[]>

		return Object.fromEntries(Object.entries(rec).map(([t, vs]) => [t, vs.join(" ")]))
	}
	const flat = decodeAsJson(await neural.parse(raw)) as Record<string, string>

	return argv.includes("--fold-gold") ? foldGoldForV0(flat) : flat
}

const byClass: Record<string, { components: number; correct: number; rows: number; died: number; samples: string[] }> =
	{}

for (const row of rows) {
	const c = (byClass[row.class] ??= { components: 0, correct: 0, rows: 0, died: 0, samples: [] })
	c.rows++
	let got: Record<string, string> = {}

	try {
		got = await parseWith(row.raw)
	} catch {
		c.died++ // every component in the row fails below
	}
	// --fold-gold grades neural on the same folded view as v0 (apples-to-apples head-to-head).
	const goldView = engine === "v0" || argv.includes("--fold-gold") ? foldGoldForV0(row.components) : row.components

	for (const [tag, gold] of Object.entries(goldView)) {
		c.components++

		if (norm(got[tag]) === norm(gold)) c.correct++
		else if (c.samples.length < 2)
			c.samples.push(`"${row.raw.slice(0, 55)}" [${tag}] exp="${gold}" got="${got[tag] ?? "(none)"}"`)
	}
}

console.log(
	`# punctuation-stress — engine=${engine}${engine === "neural" ? ` · ${arg("model")!.split("/").slice(-1)} · ship-config=${shipConfig}` : " (folded gold view)"} · ${rows.length} rows`
)
console.log("| class | rows | died | component acc |\n| --- | --: | --: | --: |")
const sidecar: Record<string, { rows: number; died: number; acc: number }> = {}
let totC = 0
let totOk = 0

for (const [cls, c] of Object.entries(byClass).sort()) {
	const acc = c.components ? (100 * c.correct) / c.components : 0
	sidecar[cls] = { rows: c.rows, died: c.died, acc: +acc.toFixed(1) }
	totC += c.components
	totOk += c.correct
	console.log(`| ${cls} | ${c.rows} | ${c.died} | ${acc.toFixed(1)}% |`)
}
console.log(
	`| **overall** | ${rows.length} | ${Object.values(byClass).reduce((a, c) => a + c.died, 0)} | **${((100 * totOk) / totC).toFixed(1)}%** |`
)
console.log("\n## sample misses (≤2/class)")

for (const [cls, c] of Object.entries(byClass).sort()) for (const s of c.samples) console.log(`- [${cls}] ${s}`)

const jsonOut = arg("json")

if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ n: rows.length, classes: sidecar }, null, "\t") + "\n")
