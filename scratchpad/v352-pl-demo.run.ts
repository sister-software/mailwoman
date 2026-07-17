import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

const ROWS = [
	"aleja Wojska Polskiego 178",
	"1600 Pennsylvania Ave NW, Washington, DC 20500",
	"350 5th Ave, New York, NY 10118",
	"Pier 39, San Francisco, CA 94133",
	"1060 W Addison St, Chicago, IL 60613",
	"400 Broad St, Seattle, WA 98109",
	"90210",
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
const b = await run("scratchpad/v352-numsplice3-cache")
for (const r of ROWS) {
	console.log(`\n${r}`)
	console.log(`  v310: ${a[r]}`)
	console.log(`  v352: ${b[r]}`)
}
