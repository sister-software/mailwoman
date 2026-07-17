/**
 * B4c FALSIFIER (no training). The tokenizer has 2 multi-digit pieces: `▁16` and `▁10` (0 continuations); every
 * neighbour is per-character (1+ continuations). If the digit defect is the continuation-postcode mass, then on a bare
 * street the SINGLE-PIECE numbers (16, 10) should escape the postcode default while their 2-piece neighbours (15, 17,
 * 18, 11..14) do NOT.
 *
 * PRE-REGISTERED: CONFIRM = `<street> 16`/`10` read house_number materially more than `<street> 15`/ `17` etc. -> the
 * vocab splice removes the mechanism, B4c is worth the tokenizer surgery. REFUTE = single-piece and multi-piece numbers
 * behave the same -> the mechanism is elsewhere.
 */
import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

const STREETS = ["Hallingrudveien", "Epleskogen", "aleja Wojska Polskiego", "Main Street", "Rue Montmartre"]
// 16 and 10 are the single-piece numbers; 15/17/18/11/12/13/14 are 2-piece.
const SINGLE = ["16", "10"]
const MULTI = ["15", "17", "11", "14"]
const c = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us" })

async function hnRate(nums: string[]) {
	let hn = 0,
		total = 0
	for (const st of STREETS)
		for (const n of nums) {
			const t = decodeAsTuples(
				await c.parse(`${st} ${n}`, {
					postcodeRepair: true,
					queryShape: computeQueryShape(`${st} ${n}`),
					enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
				})
			)
			const g: Record<string, string> = {}
			for (const [k, v] of t) g[k] = g[k] ? `${g[k]} ${v}` : v
			total++
			if (g.house_number === n) hn++
		}
	return { hn, total, rate: hn / total }
}
const single = await hnRate(SINGLE)
const multi = await hnRate(MULTI)
console.log(`\n  SINGLE-piece numbers (16,10): house_number ${single.hn}/${single.total} = ${single.rate.toFixed(3)}`)
console.log(`  MULTI-piece numbers (15,17,11,14): house_number ${multi.hn}/${multi.total} = ${multi.rate.toFixed(3)}`)
console.log(
	`  delta (single - multi): ${(single.rate - multi.rate >= 0 ? "+" : "") + (single.rate - multi.rate).toFixed(3)}`
)
