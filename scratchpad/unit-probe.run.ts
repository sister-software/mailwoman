import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"
const ROWS = [
	"123 Main St Apt 200",
	"500 Oak Ave Suite 150",
	"742 Evergreen Terrace Unit 12",
	"1 Infinite Loop Ste 300",
	"350 5th Ave #405",
	"10 Downing St Apartment 221B",
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
const b = await run("scratchpad/v354-numsplice3-full-cache")
for (const r of ROWS) {
	console.log(`\n${r}`)
	console.log(`  v310: ${a[r]}`)
	console.log(`  v354: ${b[r]}`)
}
