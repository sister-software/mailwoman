import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

const ROWS = [
	"aleja Wojska Polskiego 178", // PL — the digit defect (3-digit)
	"Øvste Skogen 121", // NO — 3-digit
	"Hallingrudveien 178", // NO street + 3-digit
	"Marszałkowska 140", // PL — 3-digit
	"1600 Pennsylvania Ave NW, Washington, DC 20500", // US 5-digit ZIP — the GUARD
	"350 5th Ave, New York, NY 10118", // US 5-digit ZIP — the GUARD
	"90210", // bare US 5-digit — GUARD
	"75008", // FR 5-digit — GUARD
]
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
const b = await run("scratchpad/v350-cache")
for (const r of ROWS) {
	console.log(`\n${r}`)
	console.log(`  v310: ${a[r]}`)
	console.log(`  v350: ${b[r]}`)
}
