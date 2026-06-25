/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #375 locality-REGRESSION probe — the v1.6.0 floors ship-blocker (us.locality 66.2 vs 72.9). The
 *   synthetic comma-less probe showed the locality START is clean; this asks the real question on
 *   the held-out US golden set: comparing the shard's BASE (v1.5.1) to v1.6.0, which rows had
 *   locality RIGHT before and WRONG after — and where did the locality text GO? The hypothesis is
 *   that the comma-less shape taught the model to over-extend street past where a comma normally
 *   stops it, so on real (comma'd) US addresses street now eats the locality. We confirm or refute
 *   by tabulating the regression rows' failure modes (absorbed-into-street / became-other-tag /
 *   dropped).
 *
 *   Run: node --experimental-strip-types scripts/eval/locality-regression-probe.ts\
 *   --baseline $MAILWOMAN_DATA_ROOT/models/quantized/model-v151-step-40000-int8.onnx\
 *   --candidate ./out/v160/model.onnx\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json --n 800
 */

import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { NeuralAddressClassifier } from "@mailwoman/neural"

const { values: args } = parseArgs({
	options: {
		baseline: { type: "string" },
		candidate: { type: "string" },
		tokenizer: { type: "string" },
		"model-card": { type: "string" },
		golden: { type: "string", default: "data/eval/golden/v0.1.2/dev/us.jsonl" },
		n: { type: "string", default: "800" },
	},
})
const N = Number(args.n)
for (const k of ["baseline", "candidate", "tokenizer"] as const) if (!args[k]) throw new Error(`--${k} required`)

const norm = (s?: string) => (s ?? "").toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim()
const wordIncludes = (hay: string, needle: string) =>
	needle.length > 0 && new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay)

// All street-family text the candidate emitted (folded), for the "did street eat it" test.
const streetFamily = (p: Record<string, string>) =>
	norm([p.street_prefix, p.street, p.street_suffix].filter(Boolean).join(" "))

const load = (modelPath: string) =>
	NeuralAddressClassifier.loadFromWeights({
		locale: "en-US",
		modelPath,
		tokenizerPath: args.tokenizer,
		modelCardPath: args["model-card"],
	})
const [base, cand] = await Promise.all([load(args.baseline!), load(args.candidate!)])

const rows = readFileSync(args.golden!, "utf8")
	.split("\n")
	.filter(Boolean)
	.slice(0, N)
	.map((l) => JSON.parse(l) as { raw: string; components: Record<string, string> })

let baseLocOk = 0
let candLocOk = 0
let regressions = 0
let improvements = 0
const failMode: Record<string, number> = {}
const examples: string[] = []

for (const row of rows) {
	const gold = norm(row.components.locality)
	if (!gold) continue
	const bp = (await base.parseJson(row.raw)) as Record<string, string>
	const cp = (await cand.parseJson(row.raw)) as Record<string, string>
	const baseOk = norm(bp.locality) === gold
	const candOk = norm(cp.locality) === gold
	if (baseOk) baseLocOk++
	if (candOk) candLocOk++
	if (candOk && !baseOk) improvements++
	if (baseOk && !candOk) {
		regressions++
		const goldRegion = norm(row.components.region)
		const cl = norm(cp.locality)
		let mode: string
		if (!cp.locality) mode = "dropped (no locality emitted)"
		else if (wordIncludes(streetFamily(cp), gold)) mode = "absorbed-into-street"
		else if (goldRegion && wordIncludes(cl, goldRegion)) mode = "locality+region MERGED (state not split off)"
		else if (norm(cp.region) === gold) mode = "became-region"
		else if (cl.includes(gold) || gold.includes(cl)) mode = "partial (truncated/extended span)"
		else mode = "other (org/venue name or unrelated span)"
		failMode[mode] = (failMode[mode] ?? 0) + 1
		if (examples.length < 10)
			examples.push(
				`  [${mode.split(" ")[0]}] "${row.raw.slice(0, 70)}"  gold loc=${row.components.locality} | got loc='${cp.locality ?? ""}'`
			)
	}
}

const scored = rows.filter((r) => norm(r.components.locality)).length
console.log(`\n== locality-regression probe — v1.5.1 base vs v1.6.0, US golden (${scored} rows w/ gold locality) ==\n`)
console.log(`  base (v1.5.1) locality exact: ${baseLocOk}/${scored} (${((100 * baseLocOk) / scored).toFixed(1)}%)`)
console.log(`  cand (v1.6.0) locality exact: ${candLocOk}/${scored} (${((100 * candLocOk) / scored).toFixed(1)}%)`)
console.log(`  net: ${improvements} improved, ${regressions} regressed  (Δ ${candLocOk - baseLocOk})`)
console.log(`\n  REGRESSION failure modes (base-right → v1.6.0-wrong, ${regressions} rows):`)
for (const [m, c] of Object.entries(failMode).sort((a, b) => b[1] - a[1]))
	console.log(`    ${((100 * c) / regressions).toFixed(0).padStart(3)}%  ${m}  (${c})`)
if (examples.length) console.log(`\n  examples:\n${examples.join("\n")}`)
console.log()
