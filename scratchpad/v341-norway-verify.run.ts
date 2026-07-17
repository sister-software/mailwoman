import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

// CONTEXTFUL Norwegian (postcode+city present) — the form the Norwegian corpus DOES contain.
// If v341 parses these better than v310, Norway flowed and the finding is "coverage helps
// contextful, not bare". If identical, investigate whether Norway flowed at all.
const ROWS = ["Tangavegen 40, 5620 Tørvikbygd", "Epleskogen 39A, 4370 Egersund", "Hallingrudveien 32, 3370 Vikersund"]
async function run(cacheRoot: string) {
	const c = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us", cacheRoot })
	const o: Record<string, string> = {}
	for (const i of ROWS) {
		const t = decodeAsTuples(
			await c.parse(i, {
				postcodeRepair: true,
				queryShape: computeQueryShape(i),
				enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
			})
		)
		const g: Record<string, string> = {}
		for (const [k, v] of t) g[k] = g[k] ? `${g[k]} ${v}` : v
		o[i] = JSON.stringify(g)
	}
	return o
}
const a = await run("scratchpad/v310-cache")
const b = await run("scratchpad/v341-cache")
for (const r of ROWS) {
	console.log(`\n${r}`)
	console.log(`  v310: ${a[r]}`)
	console.log(`  v341: ${b[r]}`)
}
