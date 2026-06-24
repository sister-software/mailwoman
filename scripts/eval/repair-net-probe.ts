/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   #723 repairLeadingHouseNumber net-effect probe. The conventions=auto US path runs ONE pass for US
 *   (repairLeadingHouseNumber; US has no forbiddenTags/postcodePattern), so parsing each US golden row
 *   with conventions OFF vs AUTO isolates the repair's end-to-end effect. For postcode + house_number
 *   we classify every row the repair changes:
 *     HELP — repair-off wrong, repair-on correct (its target: rural leading-HN-as-ZIP, no trailing ZIP)
 *     HURT — repair-off correct, repair-on wrong (the over-fire: a valid trailing ZIP got clobbered)
 *   Net = HELP − HURT. The HURT rows reveal the guard the fix needs.
 *
 *   Run: node --experimental-strip-types scripts/eval/repair-net-probe.ts --model out/v192/model.onnx
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

async function main() {
	const card = JSON.parse(readFileSync(CARD, "utf8"))
	const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), OnnxRunner.create(MODEL)])
	const neural = new NeuralAddressClassifier({
		tokenizer,
		runner,
		labels: card.labels,
		postcodeAnchorLookup: existsSync(ANCHOR) ? parseAnchorLookup(JSON.parse(readFileSync(ANCHOR, "utf8"))) : undefined,
		gazetteerLexicon: existsSync(GAZ) ? parseGazetteerLexicon(JSON.parse(readFileSync(GAZ, "utf8"))) : undefined,
		suppressGazetteerNearPostcode: true,
	})

	const rows = readFileSync(FILE, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Row)

	const tags = ["postcode", "house_number"] as const
	const stat: Record<string, { help: number; hurt: number; helpRows: string[]; hurtRows: string[] }> = {}
	for (const t of tags) stat[t] = { help: 0, hurt: 0, helpRows: [], hurtRows: [] }

	for (const row of rows) {
		const off = flat(decodeAsJson(await neural.parse(row.raw, {})))
		const on = flat(decodeAsJson(await neural.parse(row.raw, { addressSystemConventions: "auto" })))
		// Only rows the repair actually changed are interesting.
		if (norm(off.postcode) === norm(on.postcode) && norm(off.house_number) === norm(on.house_number)) continue
		for (const t of tags) {
			const gold = norm(row.components[t])
			if (!gold) continue
			const offOk = norm(off[t]) === gold
			const onOk = norm(on[t]) === gold
			if (offOk && !onOk) {
				stat[t]!.hurt++
				if (stat[t]!.hurtRows.length < 18)
					stat[t]!.hurtRows.push(
						`  raw=${JSON.stringify(row.raw)} gold.${t}=${JSON.stringify(row.components[t])} off=${JSON.stringify(off[t] ?? null)} on=${JSON.stringify(on[t] ?? null)} | on.hn=${JSON.stringify(on.house_number ?? null)} on.pc=${JSON.stringify(on.postcode ?? null)}`
					)
			} else if (!offOk && onOk) {
				stat[t]!.help++
				if (stat[t]!.helpRows.length < 12)
					stat[t]!.helpRows.push(
						`  raw=${JSON.stringify(row.raw)} gold.${t}=${JSON.stringify(row.components[t])} off=${JSON.stringify(off[t] ?? null)} on=${JSON.stringify(on[t] ?? null)}`
					)
			}
		}
	}

	console.log(`\n#723 repairLeadingHouseNumber net effect — ${MODEL} (n=${rows.length} US golden rows)`)
	for (const t of tags) {
		const s = stat[t]!
		console.log(`\n[${t}]  HELP ${s.help}  HURT ${s.hurt}  NET ${s.help - s.hurt >= 0 ? "+" : ""}${s.help - s.hurt}`)
		console.log(`  --- HURT (repair broke a correct ${t}) ---`)
		s.hurtRows.forEach((r) => console.log(r))
		console.log(`  --- HELP (repair fixed ${t}) ---`)
		s.helpRows.forEach((r) => console.log(r))
	}
}
await main()
