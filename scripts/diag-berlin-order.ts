/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Is the German "collapse" actually an ORDER-MISMATCH artifact? (#239/#240). The OA de-sample
 *   renders German addresses in US order (`{house#} {street}, {locality}, {region} {postcode}`),
 *   but the model trained on German order (`{street} {house#}, {postcode} {locality}`). This
 *   re-renders the SAME Berlin/Sachsen rows in German order and re-parses — if locality recovers
 *   sharply, the collapse is substantially an eval-rendering confound, not a parsing limit. Anchor
 *   fed throughout.
 *
 *   Run: node --experimental-strip-types scripts/diag-berlin-order.ts
 */
import { readFileSync } from "node:fs"

const { NeuralAddressClassifier, parseAnchorLookup } = await import("@mailwoman/neural")
const { OnnxRunner } = await import("@mailwoman/neural/onnx-runner")
const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")

const labels = JSON.parse(readFileSync("/tmp/pilot-eval/anchoron-card.json", "utf8")).labels as string[]
const lookup = parseAnchorLookup(
	JSON.parse(readFileSync("/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json", "utf8"))
)
const tokenizer = await MailwomanTokenizer.loadFromFile(
	"/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
)
const runner = await OnnxRunner.create("/tmp/pilot-eval/anchoron-4in.onnx")
const clf = new NeuralAddressClassifier({ tokenizer, runner, labels, postcodeAnchorLookup: lookup })

interface Row {
	input: string
	state: string
	expected: { locality?: string; postcode?: string }
}
const rows = readFileSync("data/eval/external/openaddresses-de-sample.jsonl", "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l) as Row)
	.filter((r) => r.state === "Berlin" || r.state === "Sachsen")
	.slice(0, 40)

/** US-order OA input "27 Straußstraße, Berlin, Berlin 12623" → German order "Straußstraße 27, 12623
Berlin". */
function toGermanOrder(r: Row): string | null {
	const parts = r.input.split(",").map((s) => s.trim())
	if (parts.length < 3) return null
	const m = /^(\d+\s*[A-Za-z]?)\s+(.+)$/.exec(parts[0]!) // leading house number + street
	if (!m) return null
	const [, houseNo, street] = m
	const locality = r.expected.locality ?? parts[1]
	const postcode = r.expected.postcode ?? parts[parts.length - 1]!.match(/\d{5}/)?.[0] ?? ""
	return `${street} ${houseNo}, ${postcode} ${locality}`
}

const locOf = async (text: string): Promise<string> =>
	(await clf.parseTuples(text))
		.filter(([t]) => t === "locality")
		.map(([, v]) => v)
		.join(" ") || "∅"

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
let usHit = 0
let deHit = 0
let n = 0
const byState: Record<string, { us: number; de: number; n: number }> = {}
for (const r of rows) {
	const ger = toGermanOrder(r)
	if (!ger) continue
	n++
	const gold = r.expected.locality ?? "?"
	const us = await locOf(r.input)
	const de = await locOf(ger)
	const uOk = norm(us) === norm(gold)
	const dOk = norm(de) === norm(gold)
	if (uOk) usHit++
	if (dOk) deHit++
	const b = (byState[r.state] ??= { us: 0, de: 0, n: 0 })
	b.n++
	if (uOk) b.us++
	if (dOk) b.de++
}
console.log(`\nlocality EXACT-match (anchor fed), ${n} Berlin+Sachsen rows:`)
console.log(`  US order (as the eval renders it): ${usHit}/${n} = ${((100 * usHit) / n).toFixed(1)}%`)
console.log(`  GERMAN order (as the model trained): ${deHit}/${n} = ${((100 * deHit) / n).toFixed(1)}%`)
for (const [st, b] of Object.entries(byState)) {
	console.log(
		`    ${st}: US ${((100 * b.us) / b.n).toFixed(0)}%  →  German-order ${((100 * b.de) / b.n).toFixed(0)}%  (n=${b.n})`
	)
}
process.exit(0)
