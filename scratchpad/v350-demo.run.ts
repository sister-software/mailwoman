import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"
const P = [
	"1600 Pennsylvania Ave NW, Washington, DC 20500",
	"350 5th Ave, New York, NY 10118",
	"Pier 39, San Francisco, CA 94133",
	"1060 W Addison St, Chicago, IL 60613",
	"400 Broad St, Seattle, WA 98109",
	"90210",
	"aleja Wojska Polskiego 178",
]
const c = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us", cacheRoot: "scratchpad/v350-cache" })
for (const i of P) {
	const t = decodeAsTuples(
		await c.parse(i, {
			postcodeRepair: true,
			queryShape: computeQueryShape(i),
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
		})
	)
	const g: Record<string, string> = {}
	for (const [k, v] of t) g[k] = g[k] ? `${g[k]} ${v}` : v
	console.log(`  ${i.slice(0, 44).padEnd(44)} ${JSON.stringify(g)}`)
}
