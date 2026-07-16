/**
 * V3.4.0-norway-coverage-probe read. Pre-registered: do the brief's Norwegian rows stop reading street->locality?
 * Compare v340 (Norway un-dropped, 2k off v310) vs SHIPPED v310.
 */
import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

const ROWS = [
	"Epleskogen 39A", // NORWAY — the brief's row 1 (v310: locality + postcode)
	"Tindvegen nedre 44B", // NORWAY — row 2 (v310: locality + street + postcode)
	"Øvste Skogen 121", // NORWAY — another
	"Hallingrudveien 32", // NORWAY — board-3 style bare-street-hn
	"aleja Wojska Polskiego 178", // PL control (in-corpus; the length defect, NOT coverage) — should NOT change much
	"350 5th Ave, New York, NY 10118", // US do-no-harm
]

async function run(cacheRoot?: string) {
	const c = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us", cacheRoot })
	const out: Record<string, string> = {}
	for (const input of ROWS) {
		const tup = decodeAsTuples(
			await c.parse(input, {
				postcodeRepair: true,
				queryShape: computeQueryShape(input),
				enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
			})
		)
		const g: Record<string, string> = {}
		for (const [t, v] of tup) g[t] = g[t] ? `${g[t]} ${v}` : v
		out[input] = JSON.stringify(g)
	}
	return out
}

const v310 = await run("scratchpad/v310-cache")
const v340 = await run("scratchpad/v340-cache")
console.log("row".padEnd(30), "  v310 (shipped)".padEnd(48), "v340 (Norway un-dropped)")
for (const r of ROWS) {
	console.log(`${r.padEnd(30)}  ${v310[r]!.padEnd(48)} ${v340[r]}`)
}
