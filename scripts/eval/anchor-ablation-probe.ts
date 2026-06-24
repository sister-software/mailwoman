/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   Anchor-ablation probe (DeepSeek consult 019ef789, turn 2). Hypothesis: the model mislabels a
 *   leading 5-digit house number as `postcode` because the BINARY postcode anchor FIRES on it (a real
 *   ZIP elsewhere in the country — "15715" is a PA ZIP), polluting the decision. Test: on rows whose
 *   gold house_number is a leading 5-digit AND that carry a trailing postcode, parse with the anchor
 *   feed ON vs OFF (conventions OFF both times, so the #723 repair never runs — we isolate the ANCHOR,
 *   not the repair). If anchor-OFF flips the leading from postcode→house_number, the binary anchor is
 *   the culprit → the fix is a richer anchor (region-congruence), not more data.
 *
 *   Run: node --experimental-strip-types scripts/eval/anchor-ablation-probe.ts --model out/v192/model.onnx
 */
import { type ComponentTag, decodeAsJson } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { existsSync, readFileSync } from "node:fs"

const arg = (k: string, d = ""): string => {
	const i = process.argv.indexOf(`--${k}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d
}
const MODEL = arg("model", "out/v192/model.onnx")
const TOK = arg("tokenizer", "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model")
const CARD = arg("model-card", "neural-weights-en-us/model-card.json")
const ANCHOR = arg("anchor", "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json")
const GAZ = arg("gazetteer-lexicon", "data/gazetteer/anchor-lexicon-v1.json")
const FILE = arg("file", "data/eval/golden/v0.1.2/dev/us.jsonl")

interface Row {
	raw: string
	components: Record<string, string>
}
const norm = (v: string | undefined): string => (v ?? "").trim().toLowerCase()
const flat = (t: Partial<Record<ComponentTag, string>>) => t as Record<string, string>

async function build(withAnchor: boolean) {
	const card = JSON.parse(readFileSync(CARD, "utf8"))
	const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), OnnxRunner.create(MODEL)])
	return new NeuralAddressClassifier({
		tokenizer,
		runner,
		labels: card.labels,
		postcodeAnchorLookup:
			withAnchor && existsSync(ANCHOR) ? parseAnchorLookup(JSON.parse(readFileSync(ANCHOR, "utf8"))) : undefined,
		gazetteerLexicon:
			withAnchor && existsSync(GAZ) ? parseGazetteerLexicon(JSON.parse(readFileSync(GAZ, "utf8"))) : undefined,
		suppressGazetteerNearPostcode: true,
	})
}

async function main() {
	const [on, off] = await Promise.all([build(true), build(false)])
	// Rows where the gold house_number is a leading 5-digit AND a trailing postcode exists — the exact
	// ambiguous shape the #723 repair was bolted on to handle.
	const rows = readFileSync(FILE, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Row)
		.filter((r) => /^\d{5}$/.test(r.components.house_number ?? "") && /^\d{5}$/.test(r.components.postcode ?? ""))

	let n = 0
	let onHN = 0,
		offHN = 0 // leading 5-digit correctly labelled house_number
	let onAsPC = 0,
		offAsPC = 0 // leading 5-digit MISlabelled postcode
	const flips: string[] = []
	for (const row of rows) {
		const hn = norm(row.components.house_number)
		n++
		const pOn = flat(decodeAsJson(await on.parse(row.raw, {})))
		const pOff = flat(decodeAsJson(await off.parse(row.raw, {})))
		const onOk = norm(pOn.house_number) === hn
		const offOk = norm(pOff.house_number) === hn
		if (onOk) onHN++
		if (offOk) offHN++
		if (norm(pOn.postcode) === hn) onAsPC++
		if (norm(pOff.postcode) === hn) offAsPC++
		if (!onOk && offOk && flips.length < 12)
			flips.push(
				`  raw=${JSON.stringify(row.raw)} gold.hn=${hn} | anchorON.hn=${JSON.stringify(pOn.house_number ?? null)} pc=${JSON.stringify(pOn.postcode ?? null)} → anchorOFF.hn=${JSON.stringify(pOff.house_number ?? null)} pc=${JSON.stringify(pOff.postcode ?? null)}`
			)
	}
	const pct = (x: number) => ((100 * x) / Math.max(n, 1)).toFixed(1)
	console.log(`\nanchor-ablation probe — ${MODEL}  (n=${n} rows, gold house_number = leading 5-digit + trailing ZIP)`)
	console.log(`  leading-5-digit correctly = house_number:   anchorON ${pct(onHN)}%   anchorOFF ${pct(offHN)}%`)
	console.log(`  leading-5-digit MISlabelled = postcode:      anchorON ${pct(onAsPC)}%   anchorOFF ${pct(offAsPC)}%`)
	console.log(
		`  → ${offHN > onHN ? "ANCHOR POLLUTES: removing it flips the leading toward house_number (feature-gap confirmed)" : "anchor not the dominant driver — data/capacity gap more likely"}`
	)
	console.log(`  --- example flips (anchorON wrong → anchorOFF right) ---`)
	flips.forEach((f) => console.log(f))
}
await main()
