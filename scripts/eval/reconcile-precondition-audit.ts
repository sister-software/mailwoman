import { readFileSync } from "node:fs"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 *
 *   Reconcile-vs-raw-neural precondition audit. For each row of an OA-format holdout, compares the
 *   raw neural parse (`classifier.parse`) against the assembled runtime pipeline, counting how
 *   often each yields a SEPARATE street + house_number + postcode (the minimum the forward geocoder
 *   needs). Built 2026-06-14 to quantify the joint-reconcile regression; see
 *   docs/articles/evals/2026-06-14-reconcile-retirement.md. Requires compiled `out/` trees.
 *
 *   Usage: node scripts/eval/reconcile-precondition-audit.ts <holdout.jsonl> [cap]
 */
import type { AddressTree } from "@mailwoman/core/decoder"

interface NeuralClassifier {
	parse(input: string, opts?: { postcodeRepair?: boolean }): Promise<AddressTree>
}
interface RuntimePipeline {
	(input: string, opts?: { jointReconcile?: boolean }): Promise<{ tree: AddressTree }>
}
interface HoldoutRow {
	input: string
}

const root = new URL("../../", import.meta.url)
const { NeuralAddressClassifier } = (await import(new URL("neural/out/index.js", root).href)) as {
	NeuralAddressClassifier: { loadFromWeights(opts: { locale: string }): Promise<NeuralClassifier> }
}
const { createRuntimePipeline } = (await import(new URL("mailwoman/out/runtime-pipeline.js", root).href)) as {
	createRuntimePipeline(opts: { classifier: NeuralClassifier }): RuntimePipeline
}
const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const pipeline = createRuntimePipeline({ classifier }) // no resolver → parse-only

interface TagVals {
	street: string | null
	house_number: string | null
	postcode: string | null
}
const tagvals = (tree: AddressTree): TagVals => {
	const o: TagVals = { street: null, house_number: null, postcode: null }
	const st = [...tree.roots]

	while (st.length) {
		const n = st.pop()!

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
	.map((l) => JSON.parse(l) as HoldoutRow)
const cap = Number(process.argv[3] || rows.length)
let n = 0,
	identical = 0,
	recLostStreet = 0,
	recGainedStreet = 0,
	hnDiffers = 0
let rawPrecond = 0,
	recPrecond = 0,
	rawOnlyPrecond = 0,
	recOnlyPrecond = 0
const lost: string[] = []

for (const r of rows.slice(0, cap)) {
	n++
	const raw = tagvals(await classifier.parse(r.input, { postcodeRepair: true }))
	const rec = tagvals((await pipeline(r.input)).tree)
	const rp = !!(raw.street && raw.house_number && raw.postcode),
		cp = !!(rec.street && rec.house_number && rec.postcode)

	if (rp) rawPrecond++

	if (cp) recPrecond++

	if (rp && !cp) {
		rawOnlyPrecond++

		if (lost.length < 14)
			lost.push(
				`${r.input}\n      raw: hn=${raw.house_number} st=${raw.street} pc=${raw.postcode}\n      rec: hn=${rec.house_number} st=${rec.street} pc=${rec.postcode}`
			)
	}

	if (cp && !rp) recOnlyPrecond++

	if (raw.street === rec.street && raw.house_number === rec.house_number) identical++
	else if (raw.street && !rec.street) recLostStreet++
	else if (!raw.street && rec.street) recGainedStreet++
	else if (raw.house_number !== rec.house_number) hnDiffers++
}
const pc = (x: number): string => `${((100 * x) / n).toFixed(1)}%`
console.log(`reconcile-vs-raw-neural audit (n=${n})`)
console.log(
	`  street+HN+postcode precondition:  raw ${rawPrecond} (${pc(rawPrecond)})  |  pipeline ${recPrecond} (${pc(recPrecond)})`
)
console.log(`  pipeline BREAKS it (raw had it, pipeline lost it): ${rawOnlyPrecond} (${pc(rawOnlyPrecond)})`)
console.log(`  pipeline FIXES it (pipeline had it, raw didn't):   ${recOnlyPrecond} (${pc(recOnlyPrecond)})`)
console.log(
	`  street/HN tags identical: ${identical} (${pc(identical)})  | pipeline lost street: ${recLostStreet} | pipeline gained street: ${recGainedStreet} | hn differs: ${hnDiffers}`
)

if (lost.length) {
	console.log(`\n  sample pipeline-broke-the-geocode cases:`)

	for (const s of lost) console.log(`   - ${s}`)
}
