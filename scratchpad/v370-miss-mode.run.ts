import { readFileSync } from "node:fs"

import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

const fx = readFileSync("mailwoman/eval-harness/fixtures/no-digits.jsonl", "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l))
	.filter((f) => f.klass === "bare-street-hn")
async function load(cr: string) {
	return NeuralAddressClassifier.loadFromWeights({ locale: "en-us", cacheRoot: cr })
}
const v310 = await load("scratchpad/v310-cache")
const v360 = await load("scratchpad/v370-b4b3-cache")
async function parse(c: Awaited<ReturnType<typeof load>>, i: string) {
	const t = decodeAsTuples(
		await c.parse(i, {
			postcodeRepair: true,
			queryShape: computeQueryShape(i),
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
		})
	)
	const g: Record<string, string> = {}
	for (const [k, v] of t) g[k] = g[k] ? `${g[k]} ${v}` : v
	return g
}
let shown = 0
const modes = { hn_missing: 0, hn_wrong: 0 }
for (const f of fx) {
	const want = (f.expect.house_number ?? []).join(" ")
	const g = await parse(v360, f.input)
	const got = g.house_number ?? ""
	if (got === want) continue
	if (!got) modes.hn_missing++
	else modes.hn_wrong++
	if (shown++ < 8) {
		const g310 = await parse(v310, f.input)
		console.log(`\n${f.input}   want hn=${want}`)
		console.log(`  v310: ${JSON.stringify(g310)}`)
		console.log(`  v370: ${JSON.stringify(g)}`)
	}
}
console.log(
	`\nv360 bare-street-hn miss modes: house_number MISSING(dropped/absorbed)=${modes.hn_missing}  WRONG-value=${modes.hn_wrong}`
)
