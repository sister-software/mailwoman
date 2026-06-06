/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Error-type breakdown for the anchor pilot's Berlin failure (#239/#240). Parses real Berlin
 *   OpenAddresses rows through the anchor-on model, WITH the anchor fed vs WITHOUT, and shows what the
 *   model labels the trailing city token. Answers: is "Berlin" DROPPED to O (the locale context never
 *   forms), or MISLABELED (context forms but the wrong production fires)? And does feeding the anchor
 *   change it? Also dumps the postcode-collision the ambiguity rides on.
 *
 *   Run: node --experimental-strip-types scripts/diag-berlin-anchor.ts
 */
import { readFileSync } from "node:fs"

const MODEL = "/tmp/pilot-eval/anchoron-4in.onnx"
const CARD = "/tmp/pilot-eval/anchoron-card.json"
const TOK = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const LOOKUP = "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"
const EVAL = "data/eval/external/openaddresses-de-sample.jsonl"

const { NeuralAddressClassifier, parseAnchorLookup } = await import("@mailwoman/neural")
const { OnnxRunner } = await import("@mailwoman/neural/onnx-runner")
const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")

const labels = JSON.parse(readFileSync(CARD, "utf8")).labels as string[]
const lookup = parseAnchorLookup(JSON.parse(readFileSync(LOOKUP, "utf8")))
const tokenizer = await MailwomanTokenizer.loadFromFile(TOK)
const runner = await OnnxRunner.create(MODEL)

// Two classifiers off the SAME model: one fed the real anchor, one fed a ZEROED anchor (empty lookup
// → all-zero features = the c=0 identity). Both must feed the 4 ONNX inputs the anchor model requires.
const withAnchor = new NeuralAddressClassifier({ tokenizer, runner, labels, postcodeAnchorLookup: lookup })
const noAnchor = new NeuralAddressClassifier({ tokenizer, runner, labels, postcodeAnchorLookup: new Map() })

// Show the collision the ambiguity rides on.
const collide = lookup.get("10115")
console.log(`\n# The collision: "10115" → ${JSON.stringify(collide?.posterior)} (a real Berlin PLZ AND a real NYC ZIP)\n`)

const rows = readFileSync(EVAL, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l) as { input: string; state: string; expected: { locality?: string; postcode?: string } })
	.filter((r) => r.state === "Berlin")
	.slice(0, 12)

const localityOf = async (clf: NeuralAddressClassifier, input: string): Promise<string> => {
	const tuples = await clf.parseTuples(input)
	const loc = tuples.filter(([t]) => t === "locality").map(([, v]) => v).join(" ")
	return loc || "∅"
}

console.log("input".padEnd(46), "| gold loc".padEnd(14), "| anchor-OFF".padEnd(14), "| anchor-ON")
console.log("-".repeat(96))
let offHit = 0
let onHit = 0
for (const r of rows) {
	const gold = r.expected.locality ?? "?"
	const off = await localityOf(noAnchor, r.input)
	const on = await localityOf(withAnchor, r.input)
	if (off.toLowerCase() === gold.toLowerCase()) offHit++
	if (on.toLowerCase() === gold.toLowerCase()) onHit++
	console.log(r.input.slice(0, 44).padEnd(46), "|", gold.padEnd(12), "|", off.padEnd(12), "|", on)
}
console.log("-".repeat(96))
console.log(`locality recovered: anchor-OFF ${offHit}/${rows.length}, anchor-ON ${onHit}/${rows.length}`)

// One full token-level dump so we can see WHERE "Berlin" goes.
const sample = rows.find((r) => /berlin/i.test(r.input)) ?? rows[0]!
console.log(`\n# Full parse of: "${sample.input}"`)
for (const tag of ["anchor-ON", "anchor-OFF"] as const) {
	const clf = tag === "anchor-ON" ? withAnchor : noAnchor
	const tuples = await clf.parseTuples(sample.input)
	console.log(`  ${tag}: ${tuples.map(([t, v]) => `${t}=${JSON.stringify(v)}`).join("  ")}`)
}
process.exit(0)
