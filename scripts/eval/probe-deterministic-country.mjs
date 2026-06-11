// Deterministic country tagger probe (#464): does a closed-vocab match on the TRAILING
// comma-segment beat the diluting model? matchCountry on the last segment → precision/recall
// vs gold `country` on the curated real-OOD eval. Closed vocab → precision should be ~perfect.
// Usage: node scripts/eval/probe-deterministic-country.mjs [--file <jsonl>]
import { readFileSync } from "node:fs"
import { matchCountry } from "../../codex/out/country/country.js"

const argv = process.argv.slice(2)
const fileArg = argv.indexOf("--file")
const file = fileArg >= 0 ? argv[fileArg + 1] : "data/eval/external/country-real.jsonl"

const rows = readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l))
const norm = (s) => (s ?? "").trim().toLowerCase()

let tp = 0,
	fp = 0,
	fn = 0
const misses = []
for (const row of rows) {
	const segs = row.raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
	const last = segs[segs.length - 1]
	const m = matchCountry(last)
	const predicted = m ? last : null // tag the trailing segment verbatim if it's a known country form
	const gold = row.components.country ?? null

	if (predicted && gold && norm(predicted) === norm(gold)) tp++
	else {
		if (predicted) {
			fp++
			misses.push(`FP  ${row.raw}  → tagged "${predicted}" (gold country=${gold ?? "∅"})`)
		}
		if (gold) {
			fn++
			misses.push(`FN  ${row.raw}  → gold "${gold}" not caught on trailing segment "${last}"`)
		}
	}
}
const p = tp + fp ? tp / (tp + fp) : 0
const r = tp + fn ? tp / (tp + fn) : 0
const f1 = p + r ? (2 * p * r) / (p + r) : 0
console.log(`# deterministic country (matchCountry on trailing segment) — n=${rows.length}`)
console.log(
	`P=${(100 * p).toFixed(1)}  R=${(100 * r).toFixed(1)}  F1=${(100 * f1).toFixed(1)}  (tp=${tp} fp=${fp} fn=${fn})`
)
if (misses.length) {
	console.log("\n-- misses --")
	for (const m of misses) console.log(m)
}
