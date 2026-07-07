// Deterministic po_box tagger probe (sibling of #464 country): scan comma-segments, tag the one
// matchPOBox recognizes. po_box is a designator-phrase + id in a predictable slot — the same
// closed-vocab/fixed-position shape as country, so the lever-shape taxonomy predicts a deterministic
// matcher beats a retrain. This measures precision (negatives included: "Box Canyon Rd",
// "Boxwood Lane", "Drawbridge Ave" must NOT fire) and recall on the curated real-OOD eval.
// Usage: node scripts/eval/probe-deterministic-pobox.ts [--file <jsonl>]
import { readFileSync } from "node:fs"

import { matchPOBox } from "../../codex/out/us/po-box.js"
import { arg } from "../lib/cli-args.ts"

interface EvalRow {
	raw: string
	components: { po_box?: string | null }
}

const file = arg("file", "data/eval/external/po-box-real.jsonl")

const rows = readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l) as EvalRow)
const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase()

let tp = 0,
	fp = 0,
	fn = 0
const misses: string[] = []

for (const row of rows) {
	const segs = row.raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
	let predicted: string | null = null

	for (const seg of segs) {
		if (matchPOBox(seg)) {
			predicted = seg // tag the whole matched segment as po_box
			break
		}
	}
	const gold = row.components.po_box ?? null

	if (predicted && gold && norm(predicted) === norm(gold)) {
		tp++
	} else {
		if (predicted) {
			fp++
			misses.push(`FP  ${row.raw}  → tagged "${predicted}" (gold po_box=${gold ?? "∅"})`)
		}

		if (gold) {
			fn++
			misses.push(`FN  ${row.raw}  → gold "${gold}" not caught`)
		}
	}
}
const p = tp + fp ? tp / (tp + fp) : 0
const r = tp + fn ? tp / (tp + fn) : 0
const f1 = p + r ? (2 * p * r) / (p + r) : 0
const negatives = rows.filter((r) => !r.components.po_box).length
console.log(`# deterministic po_box (matchPOBox per comma-segment) — n=${rows.length} (${negatives} negatives)`)
console.log(
	`P=${(100 * p).toFixed(1)}  R=${(100 * r).toFixed(1)}  F1=${(100 * f1).toFixed(1)}  (tp=${tp} fp=${fp} fn=${fn})`
)

if (misses.length) {
	console.log("\n-- misses --")

	for (const m of misses) {
		console.log(m)
	}
}
