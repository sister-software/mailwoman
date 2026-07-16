// The H2 follow-on falsifier: is the postcode over-emission concentrated where the anchor has NO
// data? The shipped en-us package carries postcode-us.bin only. If US rows are ~clean and NO/PL/NL
// carry the failures, the anchor's coverage gap is the mechanism and the fix is PACKAGING.
import fs from "node:fs"

import { WORD_CONSISTENCY_SHIP_DEFAULT } from "/home/lab/Projects/mailwoman/core/pipeline/index.ts"
import { NeuralAddressClassifier } from "/home/lab/Projects/mailwoman/neural/classifier.ts"
import { computeQueryShape } from "/home/lab/Projects/mailwoman/query-shape/index.ts"

const flat = (n, o = []) => {
	for (const x of n || []) {
		o.push(x)
		flat(x.children, o)
	}
	return o
}
const rows = fs
	.readFileSync("mailwoman/eval-harness/fixtures/parity-corpus.triaged.jsonl", "utf8")
	.trim()
	.split("\n")
	.map(JSON.parse)
	.filter((f) => !f.dropped && f.expect && !f.expect.postcode)

const n = await NeuralAddressClassifier.loadFromWeights({
	locale: "en-US",
	cacheRoot: "/home/lab/Projects/mailwoman/scratchpad/v264-cache",
})
const tally = {}
for (const f of rows) {
	const c = f.country ?? "??"
	tally[c] ??= { rows: 0, spurious: 0 }
	tally[c].rows++
	const pc = flat(
		(
			await n.parse(f.input, {
				postcodeRepair: true,
				queryShape: computeQueryShape(f.input),
				enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
			})
		).roots
	)
		.filter((x) => x.tag === "postcode")
		.map((x) => x.value)
		.join(" ")
	if (pc) tally[c].spurious++
}
console.log("spurious postcode (gold has NONE), by country — the anchor ships US data ONLY:\n")
console.log(`${"cc".padEnd(4)} ${"rows".padStart(5)} ${"spurious".padStart(9)} ${"rate".padStart(7)}   anchor data?`)
const has = { US: "postcode-us.bin  SHIPPED" }
const built = { DE: "postcode-de.bin  built, NOT shipped", FR: "postcode-fr.bin  built, NOT shipped" }
for (const [c, t] of Object.entries(tally).sort((a, b) => b[1].spurious / b[1].rows - a[1].spurious / a[1].rows)) {
	if (!t.rows) continue
	const note = has[c] ?? built[c] ?? "none"
	console.log(
		`${c.padEnd(4)} ${String(t.rows).padStart(5)} ${String(t.spurious).padStart(9)} ${(t.spurious / t.rows).toFixed(3).padStart(7)}   ${note}`
	)
}
const us = tally.US ?? { rows: 0, spurious: 0 }
const nonUs = Object.entries(tally)
	.filter(([c]) => c !== "US")
	.reduce((a, [, t]) => ({ rows: a.rows + t.rows, spurious: a.spurious + t.spurious }), { rows: 0, spurious: 0 })
console.log(
	`\n  US      : ${us.spurious}/${us.rows} = ${(us.spurious / Math.max(1, us.rows)).toFixed(3)}   (anchor HAS data)`
)
console.log(
	`  non-US  : ${nonUs.spurious}/${nonUs.rows} = ${(nonUs.spurious / Math.max(1, nonUs.rows)).toFixed(3)}   (anchor has NONE)`
)
