// The gate blind spot the deepparse handoff named: parity measures postcode RECALL on gold-postcode
// rows only. It never penalizes emitting a postcode where none exists. That is the T1a hallucination
// blind spot again, in a different tag — and the handoff's actionable finding (16/22 empty-hn misses
// have the number tagged `postcode`) is what the missing half was hiding.
//
// Measures, for v264 and v310:
//   1. postcode PRECISION corpus-wide: on rows with NO gold postcode, does the model emit one?
//   2. the specific hn->postcode confusion on the deepparse misses.
import fs from "node:fs"

import { WORD_CONSISTENCY_SHIP_DEFAULT } from "/home/lab/Projects/mailwoman/core/pipeline/index.ts"
import { NeuralAddressClassifier } from "/home/lab/Projects/mailwoman/neural/classifier.ts"
import { computeQueryShape } from "/home/lab/Projects/mailwoman/query-shape/index.ts"

const flat = (n, o = []) => {
	for (const x of n || []) {
		o.push(x)
		flat(x.children, o)
	}
	return o
}
const wilson = (s, n, z = 1.96) => {
	if (!n) return [0, 0]
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

const rows = fs
	.readFileSync("mailwoman/eval-harness/fixtures/parity-corpus.triaged.jsonl", "utf8")
	.trim()
	.split("\n")
	.map(JSON.parse)
	.filter((f) => !f.dropped && f.expect)
const noPc = rows.filter((f) => !f.expect.postcode)
const hnRows = rows.filter((f) => f.expect.house_number)

const run = async (root, label) => {
	const n = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: root })
	// 1. PRECISION: emitted a postcode on a row whose gold has none?
	const spurious = []
	for (const f of noPc) {
		const pc = flat((await n.parse(f.input, opts(f.input))).roots)
			.filter((x) => x.tag === "postcode")
			.map((x) => x.value)
			.join(" ")
		if (pc) spurious.push({ input: f.input, got: pc })
	}
	// 2. the hn->postcode confusion: gold has a house_number; where did the number go?
	let hnAsPc = 0,
		hnOk = 0
	const examples = []
	for (const f of hnRows) {
		const nodes = flat((await n.parse(f.input, opts(f.input))).roots)
		const gold = f.expect.house_number.join(" ").toLowerCase()
		const hn = nodes
			.filter((x) => x.tag === "house_number")
			.map((x) => x.value)
			.join(" ")
			.toLowerCase()
		if (hn === gold) {
			hnOk++
			continue
		}
		const pc = nodes
			.filter((x) => x.tag === "postcode")
			.map((x) => x.value)
			.join(" ")
			.toLowerCase()
		if (pc && (pc === gold || pc.includes(gold))) {
			hnAsPc++
			if (examples.length < 6) examples.push({ input: f.input, gold, pc })
		}
	}
	const [lo, hi] = wilson(spurious.length, noPc.length)
	console.log(`\n--- ${label} ---`)
	console.log(`  postcode PRECISION (the unmeasured half):`)
	console.log(
		`    spurious postcode on no-gold-postcode rows: ${spurious.length}/${noPc.length} = ${(spurious.length / noPc.length).toFixed(3)}  [${lo.toFixed(3)}, ${hi.toFixed(3)}]`
	)
	console.log(`  house_number -> postcode confusion:`)
	console.log(`    hn correct: ${hnOk}/${hnRows.length};  hn MIS-TAGGED AS POSTCODE: ${hnAsPc}`)
	for (const e of examples)
		console.log(
			`      ${JSON.stringify(e.input)}  hn gold=${JSON.stringify(e.gold)} -> our postcode=${JSON.stringify(e.pc)}`
		)
	return { spurious, hnAsPc, hnOk }
}

console.log(
	`parity: ${rows.length} live | ${noPc.length} rows with NO gold postcode | ${hnRows.length} with a gold house_number`
)
const a = await run("/home/lab/Projects/mailwoman/scratchpad/v264-cache", "v264 (shipped)")
const b = await run("/home/lab/Projects/mailwoman/scratchpad/v310-cache", "v310 (fr-fragment shard)")
console.log(`\n=== DELTA ===`)
console.log(
	`  spurious postcodes : ${a.spurious.length} -> ${b.spurious.length}  (${b.spurious.length - a.spurious.length >= 0 ? "+" : ""}${b.spurious.length - a.spurious.length})`
)
console.log(
	`  hn mis-tagged as pc: ${a.hnAsPc} -> ${b.hnAsPc}  (${b.hnAsPc - a.hnAsPc >= 0 ? "+" : ""}${b.hnAsPc - a.hnAsPc})`
)
console.log(`  hn correct         : ${a.hnOk} -> ${b.hnOk}  (${b.hnOk - a.hnOk >= 0 ? "+" : ""}${b.hnOk - a.hnOk})`)
