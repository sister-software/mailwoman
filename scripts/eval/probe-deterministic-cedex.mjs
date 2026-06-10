// Deterministic cedex tagger probe (FR) — third reservoir confirming the lever-shape taxonomy
// across a different locale AND a different match shape (in-segment regex, not whole-segment like
// country/po_box). CEDEX is an unambiguous French postal-routing acronym ("Courrier d'Entreprise à
// Distribution EXceptionnelle") that follows the postcode+city, optionally with an office number;
// gold span = "CEDEX" or "CEDEX <n>" (convention from the FR golden: cedex="CEDEX 08").
//
// Matcher is inline (NOT a committed codex module — that design is the operator's call, #464). If
// this confirms, the recommendation is codex/fr/cedex.ts + a matchCedex() in the same idiom as
// matchCountry/matchPOBox, fed into the shared ClosedVocabTagger.
// Usage: node scripts/eval/probe-deterministic-cedex.mjs [--file <jsonl>]
import { readFileSync } from "node:fs"

const argv = process.argv.slice(2)
const fileArg = argv.indexOf("--file")
const file = fileArg >= 0 ? argv[fileArg + 1] : "data/eval/external/cedex-real.jsonl"

// "CEDEX" + optional 1-2 digit office/arrondissement number. Anchored on word boundaries so it can't
// fire inside another token (no real French word contains "cedex").
const CEDEX_RE = /\bCEDEX(?:\s+\d{1,2})?\b/i
const matchCedex = (s) => {
	const m = typeof s === "string" ? CEDEX_RE.exec(s) : null
	return m ? m[0].replace(/\s+/g, " ").trim() : null
}

const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const norm = (s) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ")

let tp = 0,
	fp = 0,
	fn = 0
const misses = []
for (const row of rows) {
	const predicted = matchCedex(row.raw) // scan the whole address; CEDEX is unambiguous
	const gold = row.components.cedex ?? null
	if (predicted && gold && norm(predicted) === norm(gold)) tp++
	else {
		if (predicted) {
			fp++
			misses.push(`FP  ${row.raw}  → "${predicted}" (gold cedex=${gold ?? "∅"})`)
		}
		if (gold) {
			fn++
			misses.push(`FN  ${row.raw}  → gold "${gold}" not caught (got ${predicted ?? "∅"})`)
		}
	}
}
const p = tp + fp ? tp / (tp + fp) : 0
const r = tp + fn ? tp / (tp + fn) : 0
const f1 = p + r ? (2 * p * r) / (p + r) : 0
const negatives = rows.filter((r) => !r.components.cedex).length
console.log(`# deterministic cedex (CEDEX regex on raw, FR) — n=${rows.length} (${negatives} negatives)`)
console.log(`P=${(100 * p).toFixed(1)}  R=${(100 * r).toFixed(1)}  F1=${(100 * f1).toFixed(1)}  (tp=${tp} fp=${fp} fn=${fn})`)
if (misses.length) {
	console.log("\n-- misses --")
	for (const m of misses) console.log(m)
}
