// T1b — the famous-street-as-place feedback check (#727 stage-2, Tier 1).
//
// Hypothesis under test: famous streets sit in WOF as PLACES, so the gazetteer channel injects a
// locality vote on `Rue Montmartre`, the model takes it, and the resolver reinforces it — a learned
// feedback loop, the Pelias trap in soft form.
//
// This probe asks the question at the data level rather than inferring it from a score delta:
//   1. What does the real FST say about each failing Paris surface? (placetype + importance)
//   2. Would the prior actually FIRE? impBias = importance * biasScale * maxBias, and applyBias
//      keeps a tag only `if (impBias > existing)` with existing starting at 0 — so importance 0
//      biases NOTHING. A place can be in the gazetteer and still be inert.
//   3. Does turning the prior ON change the Paris score at all?
//
// Run from repo root: node scratchpad/t1b-gazetteer-feedback.mjs
import { readFileSync } from "node:fs"

import { WORD_CONSISTENCY_SHIP_DEFAULT } from "/home/lab/Projects/mailwoman/core/pipeline/index.ts"
import { NeuralAddressClassifier } from "/home/lab/Projects/mailwoman/neural/classifier.ts"
import { deserializeFST } from "/home/lab/Projects/mailwoman/resolver-wof-sqlite/fst-serialize.ts"

const FST_PATH = "/mnt/playpen/mailwoman-data/wof/fst-global-priority.bin"
const STREET = new Set(["street_prefix", "street", "street_prefix_particle", "street_suffix"])
const fold = (v) => v.toLowerCase().replace(/\s+/g, " ").trim()
const flat = (n, o = []) => {
	for (const x of n || []) {
		o.push(x)
		flat(x.children, o)
	}

	return o
}
// The same normalization fst-prior.ts applies before walking (NFKC, lowercase, strip non-alnum).
const norm = (w) =>
	w
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, "")

const rows = readFileSync("mailwoman/eval-harness/fixtures/paris-streets.jsonl", "utf8")
	.trim()
	.split("\n")
	.map(JSON.parse)

console.log(`loading FST: ${FST_PATH}`)
const fst = deserializeFST(readFileSync(FST_PATH))
console.log(`FST: ${fst.stateCount} states, ${fst.placeCount} place entries\n`)

// ---------- 1. what does the FST actually know about these surfaces? ----------
// Walk every contiguous word span of each input, exactly as buildFSTEmissionPriors does.
const hits = new Map() // surface -> [{placetype, importance, name}]

for (const row of rows) {
	const words = row.input.split(/\s+/).map(norm).filter(Boolean)

	for (let i = 0; i < words.length; i++) {
		for (let j = i + 1; j <= Math.min(words.length, i + 4); j++) {
			const span = words.slice(i, j)
			const match = fst.walk(span)

			if (!match?.accepted) continue
			const entries = fst.accepting(match.stateID)

			if (!entries?.length) continue
			hits.set(
				span.join(" "),
				entries.map((e) => ({ placetype: e.placetype, importance: e.importance, name: e.name }))
			)
		}
	}
}

console.log(`=== FST hits across the 63 Paris fixtures: ${hits.size} distinct surfaces ===\n`)
const PLACETYPE_TO_BIO = new Set(["country", "region", "locality", "postalcode"])
let inertCount = 0
let liveCount = 0

for (const [surface, entries] of [...hits].sort()) {
	const biasing = entries.filter((e) => PLACETYPE_TO_BIO.has(String(e.placetype)))
	const maxImp = Math.max(0, ...entries.map((e) => e.importance ?? 0))
	const wouldFire = biasing.length > 0 && maxImp > 0

	if (biasing.length) {
		if (wouldFire) {
			liveCount++
		} else {
			inertCount++
		}
	}
	const flag = !biasing.length ? "no-bio-tag " : wouldFire ? "FIRES     " : "INERT(i=0)"
	console.log(
		`  ${flag} ${surface.padEnd(24)} maxImportance=${maxImp.toFixed(4)}  ` +
			`${entries.map((e) => `${e.placetype}:${(e.importance ?? 0).toFixed(3)}`).join(" ")}`
	)
}

console.log(`\n  surfaces that WOULD bias a BIO tag : ${liveCount}`)
console.log(`  surfaces INERT because importance=0: ${inertCount}`)

// ---------- 2. does the prior change the Paris score? ----------
const neural = await NeuralAddressClassifier.loadFromWeights({
	locale: "en-US",
	cacheRoot: "/home/lab/Projects/mailwoman/scratchpad/v264-cache",
})

const score = async (useFST) => {
	const acc = {}
	const flips = []

	for (const row of rows) {
		const tree = await neural.parse(row.input, {
			postcodeRepair: true,
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
			...(useFST ? { fst } : {}),
		})
		const got = flat(tree.roots)
			.filter((n) => STREET.has(n.tag))
			.sort((a, b) => a.start - b.start)
			.map((n) => n.value)
			.join(" ")
		const ok = fold(got) === fold(row.expect.street.join(" "))
		const c = (acc[row.klass] ??= { hit: 0, tot: 0 })
		c.tot++

		if (ok) {
			c.hit++
		}
		flips.push({ input: row.input, klass: row.klass, ok, got })
	}

	return { acc, flips }
}

console.log(`\n=== Paris street exact-match: FST prior OFF vs ON (v264, ship config) ===\n`)
const off = await score(false)
const on = await score(true)

let offH = 0
let onH = 0
let tot = 0
console.log(`  class                          OFF     ON`)

for (const k of Object.keys(off.acc).sort()) {
	const a = off.acc[k]
	const b = on.acc[k]
	offH += a.hit
	onH += b.hit
	tot += a.tot
	const delta = b.hit - a.hit
	console.log(
		`  ${k.padEnd(28)} ${String(a.hit).padStart(2)}/${String(a.tot).padStart(2)}  ${String(b.hit).padStart(2)}/${String(b.tot).padStart(2)}  ${delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : ""}`
	)
}
console.log(`  ${"TOTAL".padEnd(28)} ${offH}/${tot}  ${onH}/${tot}   ${onH - offH >= 0 ? "+" : ""}${onH - offH}`)

const changed = off.flips.filter((f, i) => f.ok !== on.flips[i].ok)
console.log(`\n  fixtures whose verdict CHANGED with the prior on: ${changed.length}`)

for (const f of changed) {
	const after = on.flips.find((x) => x.input === f.input)
	console.log(`    ${f.ok ? "BROKE" : "FIXED"} [${f.klass}] ${JSON.stringify(f.input)}`)
	console.log(`        off=${JSON.stringify(f.got)}  on=${JSON.stringify(after.got)}`)
}
