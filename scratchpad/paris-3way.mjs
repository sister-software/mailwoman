// Does the span decode still add anything ON TOP of the shard? The flag's whole case is "+23.8pp on
// the target class" — measured v264-token vs v301-seg, i.e. BEFORE the shard existed.
import fs from "node:fs"

import { WORD_CONSISTENCY_SHIP_DEFAULT } from "/home/lab/Projects/mailwoman/core/pipeline/index.ts"
import { NeuralAddressClassifier } from "/home/lab/Projects/mailwoman/neural/classifier.ts"
import {
	decodeSegmentationsKBest,
	parseSemiCRFTransitions,
} from "/home/lab/Projects/mailwoman/neural/semi-markov-decode.ts"
import { computeQueryShape } from "/home/lab/Projects/mailwoman/query-shape/index.ts"

const STREET = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])
const fold = (v) => v.toLowerCase().replace(/\s+/g, " ").trim()
const flat = (n, o = []) => {
	for (const x of n || []) {
		o.push(x)
		flat(x.children, o)
	}
	return o
}
const rows = fs
	.readFileSync("mailwoman/eval-harness/fixtures/paris-streets.jsonl", "utf8")
	.trim()
	.split("\n")
	.map(JSON.parse)
const wilson = (s, n, z = 1.96) => {
	const p = s / n,
		z2 = z * z,
		d = 1 + z2 / n,
		c = p + z2 / (2 * n)
	const sp = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
	return [(c - sp) / d, (c + sp) / d]
}

const opts = (t) => ({
	postcodeRepair: true,
	queryShape: computeQueryShape(t),
	enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
})

const tokenScore = async (root, label) => {
	const n = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: root })
	let hit = 0
	for (const r of rows) {
		const got = flat((await n.parse(r.input, opts(r.input))).roots)
			.filter((x) => STREET.has(x.tag))
			.sort((a, b) => a.start - b.start)
			.map((x) => x.value)
			.join(" ")
		if (fold(got) === fold(r.expect.street.join(" "))) hit++
	}
	const [lo, hi] = wilson(hit, rows.length)
	console.log(
		`  ${label.padEnd(30)} ${hit}/${rows.length} = ${(hit / rows.length).toFixed(3)}  [${lo.toFixed(3)}, ${hi.toFixed(3)}]`
	)
	return hit
}

const segScore = async (root, label) => {
	const PKG = `${root}/node_modules/@mailwoman/neural-weights-en-us`
	if (!fs.existsSync(`${PKG}/semi-crf-transitions.json`)) {
		console.log(`  ${label.padEnd(30)} (no span head — n/a)`)
		return null
	}
	const grammar = parseSemiCRFTransitions(JSON.parse(fs.readFileSync(`${PKG}/semi-crf-transitions.json`, "utf8")))
	const n = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: root })
	let hit = 0
	for (const r of rows) {
		const trace = await n.traceParse(r.input, opts(r.input))
		if (!trace.spanScores) continue
		const h = decodeSegmentationsKBest(trace.spanScores, trace.tokens.length, grammar, 1)[0]
		const parts = (h?.segments ?? [])
			.filter((s) => STREET.has(grammar.segmentTypes[s.typeID]))
			.sort((a, b) => a.start - b.start)
		const got = parts
			.map((s) => trace.text.slice(trace.tokens[s.start].start, trace.tokens[s.start + s.length - 1].end).trim())
			.join(" ")
		if (fold(got) === fold(r.expect.street.join(" "))) hit++
	}
	const [lo, hi] = wilson(hit, rows.length)
	console.log(
		`  ${label.padEnd(30)} ${hit}/${rows.length} = ${(hit / rows.length).toFixed(3)}  [${lo.toFixed(3)}, ${hi.toFixed(3)}]`
	)
	return hit
}

console.log(`Paris target class (n=${rows.length}), production config:\n`)
const a = await tokenScore("/home/lab/Projects/mailwoman/scratchpad/v264-cache", "v264 token@1 (shipped)")
const b = await segScore("/home/lab/Projects/mailwoman/scratchpad/v301-cache", "v301 seg@1 (the flag's case)")
const c = await tokenScore("/home/lab/Projects/mailwoman/scratchpad/v310-cache", "v310 token@1 (shard, NO span head)")
console.log(
	`\n  the flag's original claim : v264 token -> v301 seg = ${a} -> ${b}  (${(((b - a) / rows.length) * 100).toFixed(1)}pp)`
)
console.log(
	`  the shard alone           : v264 token -> v310 token = ${a} -> ${c}  (${(((c - a) / rows.length) * 100).toFixed(1)}pp)`
)
console.log(
	`  span decode's MARGINAL value over the shard: ${b - c >= 0 ? "+" : ""}${(((b - c) / rows.length) * 100).toFixed(1)}pp`
)
