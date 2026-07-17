import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

const ROWS = [
	"1600 Pennsylvania Ave NW, Washington DC",
	"1600 Pennsylvania Ave NW Washington DC",
	"350 5th Ave New York NY",
	"100 Centre Street New York NY",
]
async function run(cr: string) {
	const c = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us", cacheRoot: cr })
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
const b = await run("scratchpad/v380-punct-cache")
for (const r of ROWS) {
	const same = a[r] === b[r] ? "  (same)" : "  <-- DIFF"
	console.log(`\n${r}${same}`)
	console.log(`  v310: ${a[r]}`)
	console.log(`  v380: ${b[r]}`)
}
