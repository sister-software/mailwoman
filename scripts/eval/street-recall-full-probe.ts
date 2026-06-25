/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #375 street-recall-on-FULL-addresses probe — DeepSeek's blind-spot guard (consult 2026-06-18) for
 *   the v1.7.0 balanced shard. Emphasizing `bare-locality` ("City, STATE" with no street) risks the
 *   model over-emitting locality and EATING the street's leading tokens on FULL addresses — a
 *   regression moderate enough to clear the coarse `us.street` floor while breaking the
 *   highest-traffic case. This measures street exact-match on the held-out US golden subset where
 *   gold has BOTH a street and a locality span, compares a baseline (v1.5.1) to a candidate, and
 *   tallies how often a street regression coincides with the gold street's leading token landing in
 *   the candidate's locality (the "eat" mechanism). The v1.7.0 gate aborts/flags if the candidate
 *   drops >1pp below v1.5.1 here.
 *
 *   Run: node --experimental-strip-types scripts/eval/street-recall-full-probe.ts\
 *   --baseline $MAILWOMAN_DATA_ROOT/models/quantized/model-v151-step-40000-int8.onnx\
 *   --candidate ./out/v170/model.onnx\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json --n 2660
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
		n: { type: "string", default: "2660" },
	},
})
const N = Number(args.n)
for (const k of ["baseline", "candidate", "tokenizer"] as const) if (!args[k]) throw new Error(`--${k} required`)

const norm = (s?: string) => (s ?? "").toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim()
const wordIncludes = (hay: string, needle: string) =>
	needle.length > 0 && new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay)

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

let full = 0
let baseOk = 0
let candOk = 0
let regr = 0
let eaten = 0
for (const row of rows) {
	const gs = norm(row.components.street)
	const gl = norm(row.components.locality)
	if (!gs || !gl) continue // full-address rows only: gold has BOTH street and locality
	full++
	const bp = (await base.parseJson(row.raw)) as Record<string, string>
	const cp = (await cand.parseJson(row.raw)) as Record<string, string>
	const bOk = norm(bp.street) === gs
	const cOk = norm(cp.street) === gs
	if (bOk) baseOk++
	if (cOk) candOk++
	if (bOk && !cOk) {
		regr++
		// the "eat" mechanism: the gold street's leading token landed in the candidate's locality span
		if (wordIncludes(norm(cp.locality), gs.split(" ")[0]!)) eaten++
	}
}

const pct = (n: number) => `${((100 * n) / full).toFixed(1)}%`
console.log(
	`\n== street-recall-full probe — base ${args.baseline} vs cand ${args.candidate} (${full} full-address rows) ==`
)
console.log(`  base street exact: ${baseOk}/${full} (${pct(baseOk)})`)
console.log(`  cand street exact: ${candOk}/${full} (${pct(candOk)})`)
console.log(
	`  delta: ${((100 * (candOk - baseOk)) / full).toFixed(2)}pp   regressions: ${regr}  (of which street→locality 'eaten': ${eaten})`
)
console.log(
	`  GUARD: candidate within 1pp of baseline (DeepSeek blind-spot: bare-locality eating the street's leading tokens)`
)
