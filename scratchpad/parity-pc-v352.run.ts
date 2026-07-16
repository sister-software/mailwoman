import { readFileSync } from "node:fs"

import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

const lines = readFileSync("mailwoman/eval-harness/fixtures/parity-corpus.triaged.jsonl", "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l))

async function pc(cr: string) {
	const c = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us", cacheRoot: cr })
	const miss: string[] = []
	let scored = 0
	for (const f of lines) {
		const gold = (f.expect?.postcode ?? []).join(" ")
		if (!gold) continue
		scored++
		const t = decodeAsTuples(
			await c.parse(f.input, {
				postcodeRepair: true,
				queryShape: computeQueryShape(f.input),
				enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
			})
		)
		const g: Record<string, string> = {}
		for (const [k, v] of t) g[k] = g[k] ? `${g[k]} ${v}` : v
		if ((g.postcode ?? "") !== gold) miss.push(`${f.input}  gold_pc=${gold} got=${JSON.stringify(g)}`)
	}
	return { miss, scored }
}

const v310 = await pc("scratchpad/v310-cache")
const v351 = await pc("scratchpad/v351-numsplice-cache")
const v352 = await pc("scratchpad/v352-numsplice3-cache")

const n = v310.scored
const rate = (m: number) => ((n - m) / n).toFixed(3)
console.log(`parity postcode (n=${n} rows with a gold postcode)`)
console.log(`  v310 (shipped):     misses=${v310.miss.length}  rate=${rate(v310.miss.length)}`)
console.log(`  v351 (8k full 10-9999): misses=${v351.miss.length}  rate=${rate(v351.miss.length)}`)
console.log(`  v352 (2k 3-digit 100-999): misses=${v352.miss.length}  rate=${rate(v352.miss.length)}`)

const v310inputs = new Set(v310.miss.map((m) => m.split("  ")[0]))
console.log("\n=== rows v352 gets WRONG on postcode that v310 got RIGHT (the guard — should be ~empty) ===")
let regressions = 0
for (const m of v352.miss)
	if (!v310inputs.has(m.split("  ")[0])) {
		regressions++
		console.log("  " + m)
	}
console.log(`\nv352 NEW postcode regressions vs v310: ${regressions}  (v351 had 7)`)
