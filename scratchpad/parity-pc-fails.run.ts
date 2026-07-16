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
	for (const f of lines) {
		const gold = (f.expect?.postcode ?? []).join(" ")
		if (!gold) continue
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
	return miss
}
const v310 = await pc("scratchpad/v310-cache")
const v351 = await pc("scratchpad/v351-numsplice-cache")
const new310 = new Set(v310)
const regressed = v351.filter((m) => !new310.has(m.split("  ")[0] + "  " + m.split("gold_pc=")[1]?.split(" got")[0]))
console.log(`v310 postcode misses: ${v310.length}  |  v351: ${v351.length}`)
console.log("\n=== rows v351 gets WRONG on postcode (that v310 didn't) ===")
const v310inputs = new Set(v310.map((m) => m.split("  ")[0]))
for (const m of v351) if (!v310inputs.has(m.split("  ")[0])) console.log("  " + m)
