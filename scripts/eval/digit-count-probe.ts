/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   DIGIT-COUNT INTERFERENCE PROBE (DeepSeek-designed, session 019ef737).
 *
 *   v1.9.2 added Australia (4-digit, postcode-FIRST) and US postcode label-F1 regressed 98→87 — but
 *   the signature is a RECALL collapse (precision held, fn 16→318), i.e. the model stops emitting
 *   `postcode` on ~300 US 5-digit ZIPs. Two hypotheses with different fixes:
 *     (a) DILUTION   — gnaf weight 6.0 just starved the US signal; a weight cut (→2.5) recovers it.
 *     (b) INTERFERENCE — the model learned a "4-digit ⇒ postcode" shortcut from AU pc-first rows that
 *         actively fights the US "leading number=house_number, 5-digit-trailing=postcode" prior; NO
 *         weight > 0 is safe, the fix is the AU order-mix + anchor change.
 *
 *   The discriminator: in US context, does the model label a 4-digit surrogate as postcode MORE than
 *   the true 5-digit ZIP? Parse each US row twice — real ZIP, then ZIP truncated to 4 digits — and
 *   read `pred.postcode`. Run BOTH v191 (control, never saw AU) and v192 (max conflict) with the SAME
 *   production anchor, so any R4 delta is the model's learned representation, not the anchor feature.
 *
 *   Read:  R5 = rate the true 5-digit ZIP is labelled postcode (= recall).
 *          R4 = rate the 4-digit surrogate is labelled postcode in the same US context.
 *     v192 R4 > R5  → interference (digit-count shortcut dominates) → weight cut alone won't fix.
 *     v192 R4 ≤ R5  AND R4 ≈ R4_v191 → dilution → gnaf 2.5 suffices.
 *
 *   Run: node --experimental-strip-types scripts/eval/digit-count-probe.ts --model out/v192/model.onnx
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
const GAZ = arg("gazetteer-lexicon", "/mnt/playpen/mailwoman-data/anchor/gazetteer-lexicon.json")
const FILE = arg("file", "data/eval/golden/v0.1.2/dev/us.jsonl")

interface Row {
	raw: string
	components: Record<string, string>
}

/** Fold neural Stage-3 tags into the golden component vocab (street parts → street). Mirrors per-locale-f1. */
function foldPostcode(flat: Partial<Record<ComponentTag, string>>): string | undefined {
	return flat.postcode
}

const norm = (v: string | undefined): string => (v ?? "").trim().toLowerCase()

async function main() {
	const card = JSON.parse(readFileSync(CARD, "utf8"))
	const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), OnnxRunner.create(MODEL)])
	const postcodeAnchorLookup =
		existsSync(ANCHOR) ? parseAnchorLookup(JSON.parse(readFileSync(ANCHOR, "utf8"))) : undefined
	const gazetteerLexicon =
		existsSync(GAZ) ? parseGazetteerLexicon(JSON.parse(readFileSync(GAZ, "utf8"))) : undefined
	const neural = new NeuralAddressClassifier({
		tokenizer,
		runner,
		labels: card.labels,
		postcodeAnchorLookup,
		gazetteerLexicon,
		suppressGazetteerNearPostcode: true,
	})
	console.error(`model=${MODEL} anchor=${postcodeAnchorLookup ? postcodeAnchorLookup.size + " codes" : "none"}`)

	const rows = readFileSync(FILE, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Row)
		.filter((r) => /^\d{5}$/.test(r.components.postcode ?? ""))

	let n = 0
	let r5Hit = 0 // true 5-digit ZIP labelled postcode
	let r4Hit = 0 // 4-digit surrogate labelled postcode (same US context)
	let r4AsHouse = 0 // 4-digit surrogate mislabelled house_number (the AU collision)
	for (const row of rows) {
		const zip5 = row.components.postcode!
		const zip4 = zip5.slice(0, 4)
		// Replace ONLY the postcode token (last occurrence, to avoid clobbering a coincident house number).
		const at = row.raw.lastIndexOf(zip5)
		if (at < 0) continue
		const raw4 = row.raw.slice(0, at) + zip4 + row.raw.slice(at + zip5.length)
		n++

		const p5 = foldPostcode(decodeAsJson(await neural.parse(row.raw, {})))
		if (norm(p5) === norm(zip5)) r5Hit++

		const flat4 = decodeAsJson(await neural.parse(raw4, {}))
		const p4 = foldPostcode(flat4)
		if (norm(p4) === norm(zip4)) r4Hit++
		else if (norm(flat4.house_number) === norm(zip4)) r4AsHouse++
	}
	const pct = (x: number) => ((100 * x) / Math.max(n, 1)).toFixed(1)
	console.log(`\ndigit-count probe (n=${n} US rows w/ 5-digit ZIP) — ${MODEL}`)
	console.log(`  R5  true 5-digit ZIP → postcode:       ${pct(r5Hit)}%   (recall)`)
	console.log(`  R4  4-digit surrogate → postcode:      ${pct(r4Hit)}%`)
	console.log(`  R4h 4-digit surrogate → house_number:  ${pct(r4AsHouse)}%   (the AU 4-digit collision)`)
	const verdict =
		r4Hit > r5Hit
			? "INTERFERENCE: model labels 4-digit > true 5-digit in US context → weight cut alone won't fix"
			: "no 4>5 inversion: consistent with DILUTION (weight cut should recover) — compare R4 vs v191 control"
	console.log(`  → ${verdict}`)
}
await main()
