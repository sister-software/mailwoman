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
	console.log(`  ${t.padEnd(30)} ${JSON.stringify(g)}`)
}
console.log("THE DESIGNATOR MINIMAL PAIR — does the word `Unit` license the intra-word split?")
await go("Unit 12/345 Main St")
await go("12/345 Main St")
console.log("\n  (the same, other designators)")
await go("Apt 12/345 Main St")
await go("Flat 3/17 Bondi Rd")
await go("3/17 Bondi Rd")
console.log("\n  (does a slash split at all, ever, without a designator?)")
await go("12/345")
await go("Unit 12/345")
