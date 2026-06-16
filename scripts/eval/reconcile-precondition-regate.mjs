/**
 * @copyright Sister Software
 * @license AGPL-3.0
 *
 *   Reconcile precondition RE-GATE (post-#565). The retirement audit showed joint-reconcile BROKE the
 *   forward-geocoder precondition (a SEPARATE street + house_number + postcode) on 77–84% of US
 *   rows vs argmax. The #565 grouper HN-bundling fix was supposed to repair that. This compares the
 *   assembled pipeline in argmax mode (`jointReconcile: false`, the #566 default) vs reconcile mode
 *   (`jointReconcile: true`) on an OA-format holdout, counting how often each preserves the
 *   precondition — and crucially how often reconcile still BREAKS a precondition argmax had.
 *
 *   This is the A.2 gate: reconcile may only be re-promoted if it preserves the precondition at
 *   parity with argmax (does not break it on a meaningful fraction of rows).
 *
 *   Usage: node scripts/eval/reconcile-precondition-regate.mjs <holdout.jsonl> [cap] Holdout rows
 *   carry `input` (OA format). Requires compiled out/.
 */
import { readFileSync } from "node:fs"

const root = new URL("../../", import.meta.url)
const { NeuralAddressClassifier } = await import(new URL("neural/out/index.js", root).href)
const { createRuntimePipeline } = await import(new URL("mailwoman/out/runtime-pipeline.js", root).href)
const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const pipeline = createRuntimePipeline({ classifier })

const tagvals = (tree) => {
	const o = { street: null, house_number: null, postcode: null }
	const st = [...tree.roots]
	while (st.length) {
		const n = st.pop()
		if (n.tag === "street" && o.street === null && n.value.trim()) o.street = n.value.trim()
		if (n.tag === "house_number" && o.house_number === null && n.value.trim()) o.house_number = n.value.trim()
		if (n.tag === "postcode" && o.postcode === null && n.value.trim()) o.postcode = n.value.trim()
		st.push(...n.children)
	}
	return o
}

const rows = readFileSync(process.argv[2] || "/tmp/ood-truth.jsonl", "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l))
const cap = Number(process.argv[3] || rows.length)
let n = 0,
	argPrecond = 0,
	recPrecond = 0,
	recBreaks = 0,
	recFixes = 0
const broke = []
for (const r of rows.slice(0, cap)) {
	const input = r.input ?? r.raw
	if (!input) continue
	n++
	const arg = tagvals((await pipeline(input, { jointReconcile: false })).tree)
	const rec = tagvals((await pipeline(input, { jointReconcile: true })).tree)
	const ap = !!(arg.street && arg.house_number && arg.postcode)
	const cp = !!(rec.street && rec.house_number && rec.postcode)
	if (ap) argPrecond++
	if (cp) recPrecond++
	if (ap && !cp) {
		recBreaks++
		if (broke.length < 14)
			broke.push(
				`${input}\n      argmax:    hn=${arg.house_number} st=${arg.street} pc=${arg.postcode}\n      reconcile: hn=${rec.house_number} st=${rec.street} pc=${rec.postcode}`
			)
	}
	if (cp && !ap) recFixes++
}
const pc = (x) => `${((100 * x) / n).toFixed(1)}%`
console.log(`reconcile precondition re-gate (n=${n})`)
console.log(
	`  street+HN+postcode precondition:  argmax ${argPrecond} (${pc(argPrecond)})  |  reconcile ${recPrecond} (${pc(recPrecond)})`
)
console.log(
	`  reconcile BREAKS it (argmax had it, reconcile lost it): ${recBreaks} (${pc(recBreaks)})  <-- the retirement metric`
)
console.log(`  reconcile FIXES it (reconcile had it, argmax didn't):   ${recFixes} (${pc(recFixes)})`)
if (broke.length) {
	console.log(`\n  sample reconcile-broke-the-precondition cases:`)
	for (const s of broke) console.log(`   - ${s}`)
}
