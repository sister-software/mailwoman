import { writeFileSync } from "node:fs"

/**
 * The brief's exact control set, on SHIPPED v6.4.0 (v310). Package-shaped default (production). Emits reconstructed
 * house_number / postcode / street per row for the comparison table.
 */
import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

const SET: Record<string, string[]> = {
	"bare-hn-like": ["39A", "44B", "121", "9600"],
	"valid-postcode": ["1234AB", "90210", "75008"],
	"invalid-postcode": ["1234SA", "0123AB"],
	"route-date-name": ["Interstate 35", "FM 3009", "11 Novembre", "10 Ave"],
	contextful: ["Epleskogen 39A", "Tindvegen nedre 44B", "aleja Wojska Polskiego 178", "9600 S Interstate 35 TX"],
}

const c = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us" })
const out: Record<string, Record<string, Record<string, string>>> = {}

for (const [klass, inputs] of Object.entries(SET)) {
	out[klass] = {}
	for (const input of inputs) {
		const tup = decodeAsTuples(
			await c.parse(input, {
				postcodeRepair: true,
				queryShape: computeQueryShape(input),
				enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
			})
		)
		const g: Record<string, string> = {}
		for (const [t, v] of tup) g[t] = g[t] ? `${g[t]} ${v}` : v
		out[klass][input] = g
		console.log(`  [${klass}] ${input.padEnd(26)} ${JSON.stringify(g)}`)
	}
}
writeFileSync("scratchpad/deepparse-cmp/brief-control-mailwoman.json", JSON.stringify(out, null, 2) + "\n")
