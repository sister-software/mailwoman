// The pre-registered "ALSO": does the fr-fragment shard reduce street hallucination on the 54
// street-free parity rows — the messy population (venues, "BOOM", "New York, NY"), not BAN communes?
import fs from "node:fs"

import { WORD_CONSISTENCY_SHIP_DEFAULT } from "/home/lab/Projects/mailwoman/core/pipeline/index.ts"
import { NeuralAddressClassifier } from "/home/lab/Projects/mailwoman/neural/classifier.ts"
import { computeQueryShape } from "/home/lab/Projects/mailwoman/query-shape/index.ts"

const STREET = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])
const flat = (n, o = []) => {
	for (const x of n || []) {
		o.push(x)
		flat(x.children, o)
	}
	return o
}
const rows = fs
	.readFileSync("mailwoman/eval-harness/fixtures/parity-corpus.triaged.jsonl", "utf8")
	.trim()
	.split("\n")
	.map(JSON.parse)
	.filter((f) => !f.dropped && f.expect && !f.expect.street)

const wilson = (s, n, z = 1.96) => {
	if (!n) return [0, 0]
	const p = s / n,
		z2 = z * z,
		d = 1 + z2 / n,
		c = p + z2 / (2 * n)
	const sp = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
	return [(c - sp) / d, (c + sp) / d]
}

const score = async (root, label) => {
	const n = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: root })
	const hits = []
	for (const fx of rows) {
		const t = await n.parse(fx.input, {
			postcodeRepair: true,
			queryShape: computeQueryShape(fx.input),
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
		})
		const s = flat(t.roots)
			.filter((x) => STREET.has(x.tag))
			.map((x) => x.value)
			.join(" ")
			.trim()
		if (s) hits.push({ input: fx.input, got: s })
	}
	const [lo, hi] = wilson(hits.length, rows.length)
	console.log(
		`  ${label.padEnd(22)} ${hits.length}/${rows.length} = ${(hits.length / rows.length).toFixed(3)}  [${lo.toFixed(3)}, ${hi.toFixed(3)}]`
	)
	return hits
}

console.log(`street-free parity rows: ${rows.length}  (the population NO street metric scores)\n`)
const a = await score("/home/lab/Projects/mailwoman/scratchpad/v264-cache", "v264 (shipped)")
const b = await score("/home/lab/Projects/mailwoman/scratchpad/v310-cache", "v310 (fr-fragment)")
const fixed = a.filter((x) => !b.some((y) => y.input === x.input))
const broke = b.filter((x) => !a.some((y) => y.input === x.input))
console.log(`\n  hallucinations REMOVED by the shard: ${fixed.length}`)
for (const f of fixed.slice(0, 10))
	console.log(`    ✓ ${JSON.stringify(f.input)}  (v264 said street=${JSON.stringify(f.got)})`)
console.log(`\n  hallucinations INTRODUCED: ${broke.length}`)
for (const f of broke.slice(0, 10)) console.log(`    ✗ ${JSON.stringify(f.input)}  -> ${JSON.stringify(f.got)}`)
