import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PROMOTE-CANARY — the autonomous-promote safeguard.
 *
 *   With the operator away and the permission wall down, a model promote no longer gets the human
 *   "does this look right on real queries" check a static held-out eval can miss. This rebuilds
 *   that check: diff a CANDIDATE model against the SHIPPED model on a set of tricky,
 *   failure-mode-rich REAL inputs, and BLOCK the promote on a right-place regression or an
 *   overconfidence spike — even when the golden eval is green.
 *
 *   The canary set is the held-out OA coordinate goldens (real truth lat/lon) put through the
 *   perturbations that expose the known failure modes: messy (abbreviated / lowercased / reordered
 *   / dash-postcode-dropped, via `messify`) and ALL-CAPS (the OOD case #690 addressed). Each
 *   perturbation preserves the truth coordinate, so every variant is gradeable right-place @25km.
 *   (cross-state same-name is a documented gap — it needs a curated pair set, not a perturbation.)
 *
 *   Two block conditions (either fires → BLOCK):
 *
 *   1. **Right-place regression** — candidate aggregate right@25km drops > AGG_TOL pp vs shipped, OR any
 *        single locale drops > LOCALE_TOL pp.
 *   2. **Overconfidence spike** — the candidate becomes newly-high-confidence (≥0.9) AND WRONG on rows
 *        the shipped model was either unsure (<0.9) or right about, beyond OVERCONF_TOL of the
 *        answered set. This is the "confident on hard inputs" failure the static eval can't see.
 *
 *   Reuses the shipped model's scored rows if `--shipped-rows <jsonl>` (a confidence-discrimination
 *   `--rows-out`) matches the canary input set, to avoid re-parsing.
 *
 *   Run: node --experimental-strip-types scripts/eval/promote-canary.ts\
 *   --shipped out/v191/model.onnx --candidate out/v192/model-int8.onnx\
 *   [--locales us,it,pt,pl,fr,au] [--n 60] [--allcaps] [--out <md>]
 */
import { createCalibrator } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { createWofResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"

import { arg } from "../lib/cli-args.ts"
import { messify, resolvedResult } from "./confidence-discrimination.ts"

const TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
const CARD = "neural-weights-en-us/model-card.json"
const ANCHOR = dataRootPath("anchor", "pilot-anchor-lookup.json")
const WOF = [dataRootPath("wof", "admin-global-priority.db"), dataRootPath("wof", "postcode-locality-intl.db")]
const CALIB = "data/eval/calibration/isotonic-en-us-v4.13.0.json"
const SHIPPED = arg("shipped", "out/v191/model.onnx")
const CANDIDATE = arg("candidate", "out/v192/model-int8.onnx")
const LOCALES = arg("locales", "us,it,pt,pl,fr,au").split(",")
const N = Number(arg("n", "60"))
const ALLCAPS = process.argv.includes("--allcaps")
const THRESH_KM = 25
const HIGH_CONF = 0.9
const AGG_TOL = 2 // pp aggregate right@25 regression that blocks
const LOCALE_TOL = 5 // pp single-locale regression that blocks
const OVERCONF_TOL = 0.03 // fraction of answered rows newly-overconfident-and-wrong that blocks

interface CanaryRow {
	cc: string
	variant: string
	answered: boolean
	right: boolean
	conf: number
}

async function collectModel(
	modelPath: string,
	inputs: Array<{ cc: string; variant: string; input: string; lat: number; lon: number }>
): Promise<CanaryRow[]> {
	const { createScorer } = await import("@mailwoman/neural/scorer")
	const { WofSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const calibrate = createCalibrator(JSON.parse(readFileSync(CALIB, "utf8")))
	const lookup = new WofSqlitePlaceLookup({ databasePath: WOF })
	const resolver = createWofResolver(lookup as never)
	const model = await createScorer({
		modelPath,
		tokenizerPath: TOK,
		modelCardPath: CARD,
		anchorLookupPath: ANCHOR,
		strict: true,
		tier: "server",
	})
	const out: CanaryRow[] = []
	let i = 0

	for (const r of inputs) {
		const tree = await model.parse(r.input, { postcodeRepair: true, calibrate })
		const resolved = await resolver.resolveTree(tree as never, { defaultCountry: r.cc.toUpperCase() })
		const c = resolvedResult(resolved as never)
		const right = c ? haversineKm(c.lat, c.lon, r.lat, r.lon) <= THRESH_KM : false
		out.push({ cc: r.cc, variant: r.variant, answered: !!c, right, conf: c?.minConf ?? 0 })

		if (++i % 25 === 0) {
			console.error(`  ${modelPath}: ${i}/${inputs.length}`)
			await sleep(300) // light thermal breather
		}
	}

	return out
}

function buildInputs(): Array<{ cc: string; variant: string; input: string; lat: number; lon: number }> {
	const inputs: Array<{ cc: string; variant: string; input: string; lat: number; lon: number }> = []

	for (const cc of LOCALES) {
		const file = `data/eval/external/oa-${cc}-coord-150.jsonl`

		if (!existsSync(file)) continue
		const goldens = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.slice(0, N)
			.map((l) => JSON.parse(l)) as Array<{
			raw: string
			lat: number
			lon: number
		}>

		for (const g of goldens) {
			inputs.push({ cc, variant: "messy", input: messify(g.raw), lat: g.lat, lon: g.lon })

			if (ALLCAPS) inputs.push({ cc, variant: "allcaps", input: g.raw.toUpperCase(), lat: g.lat, lon: g.lon })
		}
	}

	return inputs
}

function rightRate(rows: CanaryRow[]): number {
	return rows.length ? rows.filter((r) => r.right).length / rows.length : NaN
}

async function main(): Promise<void> {
	const inputs = buildInputs()
	console.error(
		`canary set: ${inputs.length} inputs (${LOCALES.join("/")}, ≤${N}/locale${ALLCAPS ? ", +allcaps" : ""})`
	)

	console.error(`\ncollecting CANDIDATE ${CANDIDATE}…`)
	const cand = await collectModel(CANDIDATE, inputs)
	console.error(`\ncollecting SHIPPED ${SHIPPED}…`)
	const ship = await collectModel(SHIPPED, inputs)

	// align by index (same input order)
	const pct = (x: number) => (Number.isNaN(x) ? "—" : `${(100 * x).toFixed(1)}%`)
	const L: string[] = []
	L.push(`# Promote canary — candidate vs shipped on perturbed real goldens\n`)
	L.push(
		`_Candidate ${CANDIDATE} vs shipped ${SHIPPED}. ${inputs.length} inputs (${LOCALES.join("/")}, ≤${N}/locale` +
			`${ALLCAPS ? ", messy+allcaps" : ", messy"}), real OA truth coords, right-place @${THRESH_KM}km. Confidence = ` +
			`min calibrated conf across resolved nodes._\n`
	)

	// aggregate
	const shipAgg = rightRate(ship)
	const candAgg = rightRate(cand)
	const aggDelta = (candAgg - shipAgg) * 100
	L.push(`## Aggregate right-place @25km\n`)
	L.push(`| | shipped | candidate | Δpp |`)
	L.push(`|---|--:|--:|--:|`)
	L.push(`| ALL | ${pct(shipAgg)} | ${pct(candAgg)} | ${aggDelta >= 0 ? "+" : ""}${aggDelta.toFixed(1)} |`)

	// per-locale
	L.push(`\n## Per-locale right-place @25km\n`)
	L.push(`| locale | shipped | candidate | Δpp |`)
	L.push(`|---|--:|--:|--:|`)
	let worstLocaleDrop = 0

	for (const cc of LOCALES) {
		const s = rightRate(ship.filter((r) => r.cc === cc))
		const c = rightRate(cand.filter((r) => r.cc === cc))

		if (Number.isNaN(s) || Number.isNaN(c)) continue
		const d = (c - s) * 100
		worstLocaleDrop = Math.min(worstLocaleDrop, d)
		L.push(`| ${cc.toUpperCase()} | ${pct(s)} | ${pct(c)} | ${d >= 0 ? "+" : ""}${d.toFixed(1)} |`)
	}

	// overconfidence spike: candidate NEWLY ≥0.9-conf AND wrong — only where shipped was RIGHT or
	// UNSURE (<0.9). A row where BOTH models are confidently-wrong is a shared pre-existing error, not
	// a v192 regression; counting it (the `!s.right` trap) over-blocks on remote-AU/PL gaps both share.
	const answered = cand.filter((r) => r.answered)
	let overconf = 0

	for (let i = 0; i < cand.length; i++) {
		const c = cand[i]!
		const s = ship[i]!

		if (c.answered && c.conf >= HIGH_CONF && !c.right && (s.right || s.conf < HIGH_CONF)) overconf++
	}
	const overconfFrac = answered.length ? overconf / answered.length : 0
	L.push(`\n## Overconfidence spike\n`)
	L.push(
		`Candidate rows newly ≥${HIGH_CONF}-confident AND wrong (where shipped was unsure or right): ` +
			`**${overconf}** = ${pct(overconfFrac)} of answered (${answered.length}).\n`
	)

	// verdict
	const regress = aggDelta < -AGG_TOL || worstLocaleDrop < -LOCALE_TOL
	const spike = overconfFrac > OVERCONF_TOL
	const block = regress || spike
	L.push(`## Verdict\n`)
	L.push(
		`- right-place regression: ${regress ? `**BLOCK** (agg Δ ${aggDelta.toFixed(1)}pp, worst locale ${worstLocaleDrop.toFixed(1)}pp; tol −${AGG_TOL}/−${LOCALE_TOL})` : `pass (agg Δ ${aggDelta.toFixed(1)}pp, worst locale ${worstLocaleDrop.toFixed(1)}pp)`}`
	)
	L.push(
		`- overconfidence spike: ${spike ? `**BLOCK** (${pct(overconfFrac)} > ${pct(OVERCONF_TOL)})` : `pass (${pct(overconfFrac)} ≤ ${pct(OVERCONF_TOL)})`}`
	)
	L.push(
		`\n### ${block ? "🚫 CANARY BLOCKS PROMOTE" : "✅ CANARY CLEARS — promote may proceed (subject to the eval gate)"}\n`
	)

	const md = L.join("\n") + "\n"
	const out = arg("out", "")

	if (out) {
		writeFileSync(out, md)
		console.error(`wrote ${out}`)
	}
	console.log(md)
	process.exit(block ? 1 : 0)
}

await main()
