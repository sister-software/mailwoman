// Per-class scorer for the punctuation-stress eval (#518). Grades EVERY component key present in
// each row's gold (exact match, case-insensitive) and reports per-class component accuracy plus
// parse SURVIVAL (a thrown parse fails every component in its row — the unbalanced-delimiter
// classes exist to measure exactly that). Conventions: punctuation-stress.README.md.
// Usage: node --experimental-strip-types scripts/eval/score-punctuation-stress.ts --model <onnx>
//   [--file data/eval/external/punctuation-stress.jsonl] [--no-ship-config]
import { decodeAsJson } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { readFileSync, writeFileSync } from "node:fs"

const argv = process.argv.slice(2)
const arg = (k: string, d?: string) => {
	const i = argv.indexOf(k)
	return i >= 0 ? argv[i + 1] : d
}
const TOK = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const LK = "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"
const file = arg("--file", "data/eval/external/punctuation-stress.jsonl")!

const card = JSON.parse(readFileSync("neural-weights-en-us/model-card.json", "utf8"))
const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), OnnxRunner.create(arg("--model")!)])
const shipConfig = !argv.includes("--no-ship-config")
const neural = new NeuralAddressClassifier({
	tokenizer,
	runner,
	labels: card.labels,
	postcodeAnchorLookup: parseAnchorLookup(JSON.parse(readFileSync(LK, "utf8"))),
	...(shipConfig ?
		{
			gazetteerLexicon: parseGazetteerLexicon(
				JSON.parse(readFileSync(arg("--gazetteer-lexicon", "data/gazetteer/anchor-lexicon-v1.json")!, "utf8"))
			),
			suppressGazetteerNearPostcode: true,
			addressSystemConventions: "auto" as const,
			bridgePunctuationGaps: true,
		}
	:	{}),
})

interface Row {
	raw: string
	components: Record<string, string>
	class: string
}
const rows: Row[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const norm = (s?: string) => (s ?? "").trim().toLowerCase()

const byClass: Record<string, { components: number; correct: number; rows: number; died: number; samples: string[] }> = {}
for (const row of rows) {
	const c = (byClass[row.class] ??= { components: 0, correct: 0, rows: 0, died: 0, samples: [] })
	c.rows++
	let got: Record<string, string> = {}
	try {
		got = decodeAsJson(await neural.parse(row.raw)) as Record<string, string>
	} catch {
		c.died++ // every component in the row fails below
	}
	for (const [tag, gold] of Object.entries(row.components)) {
		c.components++
		if (norm(got[tag]) === norm(gold)) c.correct++
		else if (c.samples.length < 2)
			c.samples.push(`"${row.raw.slice(0, 55)}" [${tag}] exp="${gold}" got="${got[tag] ?? "(none)"}"`)
	}
}

console.log(`# punctuation-stress — ${arg("--model")!.split("/").slice(-1)} · ${rows.length} rows · ship-config=${shipConfig}`)
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
console.log(`| **overall** | ${rows.length} | ${Object.values(byClass).reduce((a, c) => a + c.died, 0)} | **${((100 * totOk) / totC).toFixed(1)}%** |`)
console.log("\n## sample misses (≤2/class)")
for (const [cls, c] of Object.entries(byClass).sort()) for (const s of c.samples) console.log(`- [${cls}] ${s}`)

const jsonOut = arg("--json")
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ n: rows.length, classes: sidecar }, null, "\t") + "\n")
