import { readFileSync, writeFileSync } from "node:fs"

/**
 * B0 arm 1 — mailwoman on the intra-word control set.
 *
 * Ship config, package-shaped (#718), against the PROMOTED v310. Writes the raw spans so the scorer grades tuples
 * rather than my reading of them.
 */
import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"

const BASE = "scratchpad"
const control = JSON.parse(readFileSync(`${BASE}/intraword-control.json`, "utf8")) as {
	benefit: ControlRow[]
	cost: ControlRow[]
}

interface ControlRow {
	input: string
	why: string
	expect: Record<string, string>
	contested?: boolean
	source?: string
}

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us" })
const out: unknown[] = []

for (const arm of ["benefit", "cost"] as const) {
	for (const row of control[arm]) {
		const shape = computeQueryShape(row.input)
		const tuples = decodeAsTuples(
			await classifier.parse(row.input, {
				postcodeRepair: true,
				queryShape: shape,
				enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
			})
		)
		const got: Record<string, string> = {}
		for (const [tag, value] of tuples) {
			got[tag] = got[tag] ? `${got[tag]} ${value}` : value
		}
		out.push({ arm, input: row.input, why: row.why, expect: row.expect, contested: !!row.contested, mailwoman: got })
	}
}

writeFileSync(`${BASE}/deepparse-cmp/intraword-mailwoman.json`, `${JSON.stringify(out, null, 2)}\n`)
console.log(`wrote ${out.length} rows -> scratchpad/deepparse-cmp/intraword-mailwoman.json`)
for (const r of out as { arm: string; input: string; mailwoman: Record<string, string> }[]) {
	console.log(`  [${r.arm.padEnd(7)}] ${r.input.padEnd(34)} ${JSON.stringify(r.mailwoman)}`)
}
