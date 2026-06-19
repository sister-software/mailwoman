/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #375 boundary-stress GATE — the promote/no-promote verdict for the v1.6.0 boundary-instability
 *   retrain. Same four stress shapes as the "before" baseline (boundary-stress-baseline.ts), graded
 *   against the recipe's PRE-REGISTERED targets + the shared street-span floor. Emits a per-shape
 *   table and a single PROMOTE / NO-PROMOTE line; exit 0 = all targets met, exit 1 = any miss.
 *
 *   Unlike the baseline (which hard-codes the dev weights), this accepts an explicit model so it can
 *   grade a freshly-trained checkpoint WITHOUT touching the neural-weights symlink (which yarn test
 *   re-creates). The classifier is built via the canonical `createScorer`
 *   (`@mailwoman/neural/scorer`, #718) in STRICT mode, so the model is fed the full SHIP-CONFIG it
 *   was TRAINED against — anchor + gazetteer + conventions, per the model-card's `requires` block —
 *   and the gate FAILS CLOSED if a declared channel can't be fed. This closes the #566/#685 trap
 *   the gate previously walked into: it built the classifier via `loadFromWeights` with NO
 *   anchor/gazetteer/conventions, so the anchor-trained STAGE3 model was scored ANCHOR-OFF
 *   (out-of-distribution on exactly the admin- adjacent boundary shapes this gate measures). The
 *   model-card is therefore MANDATORY for a custom model (`createScorer` reads its label vocab AND
 *   `requires`); without it the gate now throws rather than silently mis-decoding the 33-label
 *   STAGE3 model.
 *
 *   Run (baseline, dev weights): node --experimental-strip-types scripts/eval/boundary-stress-gate.ts
 *   Run (a fetched v1.6.0 bundle): node --experimental-strip-types
 *   scripts/eval/boundary-stress-gate.ts\
 *   --model ./out/v160/model.onnx\
 *   --tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card ./out/v160/model-card.json # crf-transitions.json beside --model is auto-picked
 */

import { parseArgs } from "node:util"

import { decodeAsJson } from "@mailwoman/core/decoder"
import { createScorer } from "@mailwoman/neural/scorer"
import { resolveWeights } from "@mailwoman/neural/weights"

import {
	type BoundaryStressTemplate,
	synthesizeBoundaryStressRow,
} from "../../corpus/src/synthesize-boundary-stress.ts"

const { values: args } = parseArgs({
	options: {
		model: { type: "string" },
		tokenizer: { type: "string" },
		"model-card": { type: "string" },
		n: { type: "string", default: "300" },
	},
})
const N = Number(args.n)

// The pre-registered gate (v1.6.0-boundary-stress.yaml). Per shape: the stress tag it teaches, the
// re-baselined "before" number, and the target the retrain must clear. PLUS the shared street-span
// floor (≥65 on all four shapes) — the street is the common casualty across every shape.
const TARGETS: Record<BoundaryStressTemplate, { tag: string; baseline: number; target: number }> = {
	"street-eats-affix": { tag: "street_suffix", baseline: 41.7, target: 55 },
	"comma-less-city-state": { tag: "street", baseline: 47, target: 65 },
	"fr-prefix": { tag: "street_prefix", baseline: 55, target: 70 },
	"house-number-after-street": { tag: "house_number", baseline: 51.3, target: 65 },
}
const STREET_SPAN_FLOOR = 65

function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// Route through the canonical ProductionScorer (#718): feed the model the full SHIP-CONFIG it was
// TRAINED against (anchor + gazetteer + conventions, per the model-card's `requires` block). The
// prior loadFromWeights construction fed NO anchor/gazetteer/conventions, so this anchor-trained
// STAGE3 model was scored ANCHOR-OFF — out-of-distribution on exactly the admin-adjacent boundary
// shapes this gate measures (the #566/#685 trap). createScorer in `strict` mode FAILS CLOSED if a
// declared channel can't actually be fed, so a silent OOD re-grade can't recur.
if (args.model && !args.tokenizer) throw new Error("--tokenizer is required when --model is passed")
if (args.model && !args["model-card"])
	throw new Error("--model-card is required when --model is passed (createScorer reads its `requires` SHIP-CONFIG)")

// Dev-weights default (no --model): resolve the en-us package paths so the scorer gets concrete
// model/tokenizer/model-card paths instead of the symlink auto-resolve.
const resolved = args.model
	? { modelPath: args.model, tokenizerPath: args.tokenizer!, modelCardPath: args["model-card"]! }
	: resolveWeights({ locale: "en-us" })
if (!resolved.modelPath || !resolved.tokenizerPath || !resolved.modelCardPath)
	throw new Error("createScorer needs model + tokenizer + model-card paths; resolveWeights returned incomplete paths")

const classifier = await createScorer({
	modelPath: resolved.modelPath,
	tokenizerPath: resolved.tokenizerPath,
	modelCardPath: resolved.modelCardPath,
	strict: true,
})
const random = mulberry32(20260617)

type ShapeResult = {
	template: BoundaryStressTemplate
	tag: string
	baseline: number
	target: number
	stressPct: number
	streetPct: number
	pass: boolean
}
const results: ShapeResult[] = []

for (const template of Object.keys(TARGETS) as BoundaryStressTemplate[]) {
	const { tag, baseline, target } = TARGETS[template]
	let stressHit = 0
	const perKey: Record<string, { hit: number; n: number }> = {}
	for (let i = 0; i < N; i++) {
		const row = synthesizeBoundaryStressRow(undefined, { random, forceTemplate: template })
		const json = decodeAsJson(await classifier.parse(row.raw, { postcodeRepair: true })) as Record<string, unknown>
		const got: Record<string, string> = {}
		const collect = (o: Record<string, unknown>): void => {
			for (const [k, v] of Object.entries(o)) {
				if (typeof v === "string") got[k] = v
				else if (v && typeof v === "object") collect(v as Record<string, unknown>)
			}
		}
		collect(json)
		for (const [k, gold] of Object.entries(row.components)) {
			const a = (perKey[k] ??= { hit: 0, n: 0 })
			a.n++
			if ((got[k] ?? "").toLowerCase().trim() === String(gold).toLowerCase().trim()) a.hit++
		}
		const goldStress = String(row.components[tag as keyof typeof row.components] ?? "")
		if ((got[tag] ?? "").toLowerCase().trim() === goldStress.toLowerCase().trim()) stressHit++
	}
	const stressPct = (100 * stressHit) / N
	const street = perKey["street"]
	const streetPct = street ? (100 * street.hit) / street.n : NaN
	const pass = stressPct >= target && (Number.isNaN(streetPct) || streetPct >= STREET_SPAN_FLOOR)
	results.push({ template, tag, baseline, target, stressPct, streetPct, pass })
}

const pad = (s: string, n: number) => s.padEnd(n)
console.log(`\n== boundary-stress gate — model: ${args.model ?? "dev weights (en-US)"} (n=${N}/shape) ==\n`)
console.log(
	`  ${pad("shape", 28)} ${pad("tag", 14)} ${pad("base→target", 13)} ${pad("actual", 8)} ${pad("street", 8)} verdict`
)
for (const r of results) {
	const street = Number.isNaN(r.streetPct) ? "  n/a " : `${r.streetPct.toFixed(1)}%`
	console.log(
		`  ${pad(r.template, 28)} ${pad(r.tag, 14)} ${pad(`${r.baseline}→${r.target}`, 13)} ${pad(`${r.stressPct.toFixed(1)}%`, 8)} ${pad(street, 8)} ${r.pass ? "✓ PASS" : "✗ MISS"}`
	)
}
const allPass = results.every((r) => r.pass)
console.log(`\n  street-span floor: ≥${STREET_SPAN_FLOOR}% on every shape  ·  targets: stress-tag ≥ per-shape`)
console.log(`\n  VERDICT: ${allPass ? "✅ PROMOTE (4-shape gate met)" : "⛔ NO-PROMOTE (target/floor miss above)"}`)
console.log(`  NOTE: this is the 4-shape TARGET gate only. The per-locale non-regression FLOORS (US street ≥80.4,`)
console.log(`        locality ≥72.9, fr.house_number ≥87, FR postcode ≥99.5, affix, DE locality ≥83.8) are a`)
console.log(`        SEPARATE gate — run scripts/promotion-gate.sh. Both must hold to ship.\n`)
process.exit(allPass ? 0 : 1)
