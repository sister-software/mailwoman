/**
 * The one non-coverage digit-ownership failure: PL is in the corpus AND admitted by the filter, the street parses
 * correctly, yet `aleja Wojska Polskiego 178` -> postcode. B1's coverage story does NOT cover this. Question: does it
 * carry B0's piece-level signature — B-house_number on the first digit piece, I-postcode on the continuations — i.e.
 * the SAME licence-incoherence, cross-lingual and independent of coverage? Or a different mechanism?
 *
 * PRE-REGISTERED READ (before the numbers): if the digit run shows B-hn(first) high AND I-pc(cont) winning by summed
 * mass -> SAME defect as the Norwegian/French rows, real beyond coverage. If the street itself is mis-tagged (locality)
 * -> it is the Track A leak again (coverage-adjacent). If neither -> a new lead.
 */
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

const softmax = (row: number[]) => {
	const m = Math.max(...row)
	const e = row.map((v) => Math.exp(v - m))
	const s = e.reduce((a, b) => a + b, 0)

	return e.map((v) => v / s)
}

const c = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us" })
const ROWS = [
	"aleja Wojska Polskiego 178", // the parity failure
	"aleja Wojska Polskiego 12", // shorter number
	"ulica Marszałkowska 140",
	"ulica Piękna 24",
	"aleja Jerozolimskie 91",
]

for (const input of ROWS) {
	const t = await c.traceParse(input, { queryShape: computeQueryShape(input) })
	const { pieces, logits, labels } = t
	const idx = (l: string) => labels.findIndex((x) => x === l)
	const iBhn = idx("B-house_number"),
		iIhn = idx("I-house_number")
	const iBpc = idx("B-postcode"),
		iIpc = idx("I-postcode")
	console.log(`\n"${input}"`)
	// argmax per piece + the digit-run posteriors
	let inDigit = false
	for (let k = 0; k < pieces.length; k++) {
		const pc = pieces[k]!.piece
		const isDigit = /\d/.test(pc)
		const p = softmax(logits[k]!)
		const arg = labels[p.indexOf(Math.max(...p))]
		if (isDigit) {
			const role = inDigit ? "cont" : "START"
			inDigit = true
			console.log(
				`  ${JSON.stringify(pc).padEnd(6)} ${role.padEnd(5)} argmax=${arg!.padEnd(16)} ` +
					`B-hn=${(p[iBhn] ?? 0).toFixed(3)} I-hn=${(p[iIhn] ?? 0).toFixed(3)} ` +
					`B-pc=${(p[iBpc] ?? 0).toFixed(3)} I-pc=${(p[iIpc] ?? 0).toFixed(3)}`
			)
		} else {
			inDigit = false
			console.log(`  ${JSON.stringify(pc).padEnd(6)} word  argmax=${arg}`)
		}
	}
}
