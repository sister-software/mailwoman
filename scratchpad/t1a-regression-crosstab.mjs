// T1a — the regression-class cross-tab (#727 stage-2, Tier 1a).
//
// The aggregate hides the flows. Under production config the span decode TIES the shipped model on
// street rank-1 (154/267 vs 154/267) — but a tie can be 154 identical rows, or it can be 20 fixed
// and 20 broken. Before shipping the decode behind a flag we have to name what it breaks.
//
// Three questions:
//   1. WITHIN-MODEL cross-tab (v301 token@1 x v301 seg@1): what does the decode change, holding the
//      model fixed? This isolates the DECODE.
//   2. SHIP cross-tab (v264 token@1 x v301 seg@1): what would a user see switching to the flag?
//      This is the decision that matters.
//   3. HALLUCINATION (the pre-registered falsifier): does the span decode emit a street where the
//      gold has NONE? The street metric CANNOT see this — every street harness filters to fixtures
//      with `expect.street`, so a spurious street on a postcode-only row is invisible by
//      construction. 321 live fixtures, 267 street-gold ⇒ 54 rows where hallucination could hide.
//      Pre-registered read: if the regression class is "street hallucinated where none exists",
//      that is a NEW failure mode and the flag stays off-by-default regardless of the aggregate.
//
// Run from repo root: node scratchpad/t1a-regression-crosstab.mjs
import fs from "node:fs"

import { WORD_CONSISTENCY_SHIP_DEFAULT } from "/home/lab/Projects/mailwoman/core/pipeline/index.ts"
import { NeuralAddressClassifier } from "/home/lab/Projects/mailwoman/neural/classifier.ts"
import {
	decodeSegmentationsKBest,
	parseSemiCRFTransitions,
} from "/home/lab/Projects/mailwoman/neural/semi-markov-decode.ts"
import { computeQueryShape } from "/home/lab/Projects/mailwoman/query-shape/index.ts"

const V264 = "/home/lab/Projects/mailwoman/scratchpad/v264-cache"
const V301 = "/home/lab/Projects/mailwoman/scratchpad/v301-cache"
const PKG301 = `${V301}/node_modules/@mailwoman/neural-weights-en-us`
const STREET = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])
const fold = (v) => v.toLowerCase().replace(/\s+/g, " ").trim()
const flat = (n, o = []) => {
	for (const x of n || []) {
		o.push(x)
		flat(x.children, o)
	}

	return o
}

const grammar = parseSemiCRFTransitions(JSON.parse(fs.readFileSync(`${PKG301}/semi-crf-transitions.json`, "utf8")))
const rows = fs
	.readFileSync("mailwoman/eval-harness/fixtures/parity-corpus.triaged.jsonl", "utf8")
	.trim()
	.split("\n")
	.map(JSON.parse)
	.filter((f) => !f.dropped && f.expect)

const shipOpts = (input) => ({
	postcodeRepair: true,
	queryShape: computeQueryShape(input),
	enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
})

const tokenStreet = async (neural, input) => {
	const tree = await neural.parse(input, shipOpts(input))

	return fold(
		flat(tree.roots)
			.filter((n) => STREET.has(n.tag))
			.sort((a, b) => a.start - b.start)
			.map((n) => n.value)
			.join(" ")
	)
}

const segStreet = async (neural, input) => {
	const trace = await neural.traceParse(input, shipOpts(input))

	if (!trace.spanScores) return null
	const hyps = decodeSegmentationsKBest(trace.spanScores, trace.tokens.length, grammar, 1)
	const parts = (hyps[0]?.segments ?? [])
		.filter((s) => STREET.has(grammar.segmentTypes[s.typeID]))
		.sort((a, b) => a.start - b.start)
	const out = []

	for (const s of parts) {
		const a = trace.tokens[s.start]
		const b = trace.tokens[s.start + s.length - 1]
		out.push(trace.text.slice(a.start, b.end).trim())
	}

	return fold(out.join(" "))
}

console.log("loading v264 + v301…")
const n264 = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: V264 })
const n301 = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: V301 })

const recs = []

for (const fx of rows) {
	const gold = fx.expect.street ? fold(fx.expect.street.join(" ")) : null
	recs.push({
		id: fx.id,
		country: fx.country,
		input: fx.input,
		gold,
		shipped: await tokenStreet(n264, fx.input),
		token: await tokenStreet(n301, fx.input),
		seg: await segStreet(n301, fx.input),
	})
}

const streetGold = recs.filter((r) => r.gold !== null)
const noStreetGold = recs.filter((r) => r.gold === null)

const crosstab = (label, aName, bName, aOK, bOK, set) => {
	const cells = { both: [], aOnly: [], bOnly: [], neither: [] }

	for (const r of set) {
		const a = aOK(r)
		const b = bOK(r)

		if (a && b) cells.both.push(r)
		else if (a && !b) cells.aOnly.push(r)
		else if (!a && b) cells.bOnly.push(r)
		else cells.neither.push(r)
	}
	console.log(`\n=== ${label}  (n=${set.length}) ===`)
	console.log(`                        ${bName} ✓   ${bName} ✗`)
	console.log(
		`  ${aName} ✓          ${String(cells.both.length).padStart(8)}   ${String(cells.aOnly.length).padStart(8)}   <- REGRESSION`
	)
	console.log(
		`  ${aName} ✗          ${String(cells.bOnly.length).padStart(8)}   ${String(cells.neither.length).padStart(8)}`
	)
	console.log(
		`  net: ${cells.bOnly.length - cells.aOnly.length >= 0 ? "+" : ""}${cells.bOnly.length - cells.aOnly.length}  (fixed ${cells.bOnly.length}, broke ${cells.aOnly.length})`
	)

	return cells
}

// ---------- 1. within-model: does the DECODE help, holding the model fixed? ----------
const within = crosstab(
	"WITHIN-MODEL — v301 token@1 x v301 seg@1",
	"token",
	"seg  ",
	(r) => r.token === r.gold,
	(r) => r.seg === r.gold,
	streetGold
)

// ---------- 2. ship decision: shipped model vs the flag ----------
const ship = crosstab(
	"SHIP DECISION — v264 token@1 (shipped) x v301 seg@1 (the flag)",
	"v264 ",
	"v301s",
	(r) => r.shipped === r.gold,
	(r) => r.seg === r.gold,
	streetGold
)

// ---------- 3. the regression class, named ----------
const classify = (r) => {
	if (!r.seg) return "seg-emitted-nothing"

	if (r.gold && r.seg && r.gold.includes(r.seg)) return "truncated (seg ⊂ gold)"

	if (r.gold && r.seg && r.seg.includes(r.gold)) return "over-extended (gold ⊂ seg)"

	return "different-span"
}

console.log(`\n=== THE SHIP REGRESSION CLASS — ${ship.aOnly.length} fixtures the flag BREAKS ===`)
const byShape = {}

for (const r of ship.aOnly) {
	const shape = classify(r)
	;(byShape[shape] ??= []).push(r)
}

for (const [shape, list] of Object.entries(byShape).sort((a, b) => b[1].length - a[1].length)) {
	console.log(`\n  --- ${shape}: ${list.length} ---`)

	for (const r of list.slice(0, 10)) {
		console.log(`    ${r.country} ${JSON.stringify(r.input)}`)
		console.log(`        gold=${JSON.stringify(r.gold)}`)
		console.log(`        v264=${JSON.stringify(r.shipped)}  v301seg=${JSON.stringify(r.seg)}`)
	}
}

console.log(`\n=== THE SHIP WIN CLASS — ${ship.bOnly.length} fixtures the flag FIXES ===`)

for (const r of ship.bOnly.slice(0, 10)) {
	console.log(`    ${r.country} ${JSON.stringify(r.input)}`)
	console.log(`        gold=${JSON.stringify(r.gold)}`)
	console.log(`        v264=${JSON.stringify(r.shipped)}  v301seg=${JSON.stringify(r.seg)}`)
}

// ---------- 4. THE FALSIFIER: hallucination on rows with no gold street ----------
console.log(`\n\n=== HALLUCINATION CHECK — ${noStreetGold.length} fixtures with NO gold street ===`)
console.log(`(the street metric filters these out entirely — a spurious street here is invisible to every`)
console.log(` street number in the arc, including oracle@k)\n`)

const halluc = { shipped: [], token: [], seg: [] }

for (const r of noStreetGold) {
	if (r.shipped) halluc.shipped.push(r)

	if (r.token) halluc.token.push(r)

	if (r.seg) halluc.seg.push(r)
}
const rate = (x) => `${x.length}/${noStreetGold.length} = ${(x.length / noStreetGold.length).toFixed(3)}`
console.log(`  v264 token@1 emits a street : ${rate(halluc.shipped)}`)
console.log(`  v301 token@1 emits a street : ${rate(halluc.token)}`)
console.log(`  v301 seg@1   emits a street : ${rate(halluc.seg)}   <- THE FALSIFIER`)

const segOnly = halluc.seg.filter((r) => !r.shipped)
console.log(`\n  NEW hallucinations the flag introduces (v264 silent, v301 seg emits): ${segOnly.length}`)

for (const r of segOnly.slice(0, 12)) {
	console.log(`    ${r.country} ${JSON.stringify(r.input)}\n        v301seg=${JSON.stringify(r.seg)}`)
}

fs.writeFileSync(
	"scratchpad/t1a-crosstab.json",
	JSON.stringify(
		{
			within: Object.fromEntries(Object.entries(within).map(([k, v]) => [k, v.length])),
			ship: Object.fromEntries(Object.entries(ship).map(([k, v]) => [k, v.length])),
			recs,
		},
		null,
		1
	)
)
console.log(`\nfull per-fixture records -> scratchpad/t1a-crosstab.json`)
