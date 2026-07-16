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
const c = await NeuralAddressClassifier.loadFromWeights({
	locale: "en-us",
	cacheRoot: "scratchpad/v371-b4b3-full-cache",
})

const byLen: Record<string, { n: number; miss: number; toPostcode: number; absorbed: number }> = {}
for (const f of fx) {
	const want = (f.expect.house_number ?? []).join(" ")
	const digits = (want.match(/\d/g) ?? []).length
	const key = digits <= 1 ? "1-digit" : digits === 2 ? "2-digit" : digits === 3 ? "3-digit" : "4+digit"
	byLen[key] ??= { n: 0, miss: 0, toPostcode: 0, absorbed: 0 }
	byLen[key].n++
	const t = decodeAsTuples(
		await c.parse(f.input, {
			postcodeRepair: true,
			queryShape: computeQueryShape(f.input),
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
		})
	)
	const g: Record<string, string> = {}
	for (const [k, v] of t) g[k] = g[k] ? `${g[k]} ${v}` : v
	if ((g.house_number ?? "") === want) continue
	byLen[key].miss++
	if (g.postcode?.includes(want)) byLen[key].toPostcode++
	else if (g.street?.includes(want)) byLen[key].absorbed++
}
console.log("bare-street-hn misses by house_number digit length (v371):")
console.log("len       n   miss   rate    ->postcode  ->absorbed")
for (const k of ["1-digit", "2-digit", "3-digit", "4+digit"]) {
	const b = byLen[k]
	if (!b) continue
	console.log(
		`${k.padEnd(9)} ${String(b.n).padStart(3)}  ${String(b.miss).padStart(4)}  ${(b.miss / b.n).toFixed(3)}       ${String(b.toPostcode).padStart(4)}       ${String(b.absorbed).padStart(4)}`
	)
}
