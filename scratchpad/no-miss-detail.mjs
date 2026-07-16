import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

const c = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us" })
const go = async (t) => {
	const s = computeQueryShape(t)
	const tup = decodeAsTuples(
		await c.parse(t, { postcodeRepair: true, queryShape: s, enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT })
	)
	const g = {}
	for (const [k, v] of tup) g[k] = g[k] ? `${g[k]} ${v}` : v
	console.log(`  ${t.padEnd(28)} ${JSON.stringify(g)}`)
}
console.log("bare-street-hn misses — where does the DIGIT actually go?")
for (const t of [
	"Hallingrudveien 32",
	"Tømmerlien 3",
	"Slåstugugeilen 7C",
	"Nordtømmesvegen 178",
	"Leppdalsvegen 1285",
])
	await go(t)
console.log("\nslash-hn — the NO cadastral form")
for (const t of ["Øvrabø 124/1", "Ualand 123/4-1"]) await go(t)
console.log("\nthe SAME streets WITH a postcode (street-led, reads 0.968)")
for (const t of ["Hallingrudveien 32, 3370 Vikersund", "Tømmerlien 3, 2870 Dokka"]) await go(t)
