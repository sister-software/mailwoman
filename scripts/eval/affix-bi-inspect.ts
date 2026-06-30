/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #375 street-eats-affix B/I inspector. The confidence probe showed the model emits I-street_suffix
 *   (not B-) at the suffix token, confidently (P~0.92) — it KNOWS it's a suffix but starts the span
 *   as a continuation. This asks what the DECODE does with that orphan-I: does the suffix come out
 *   as a correct separate span, get merged into street, get dropped, or land somewhere else?
 *   Characterizing it says whether the fix is cheap (decode/CRF-transition/label) or wants
 *   augmentation like hn-after.
 *
 *   Run: node --experimental-strip-types scripts/eval/affix-bi-inspect.ts\
 *   --model ./out/v160/model.onnx\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json --n 300
 */

import { parseArgs } from "node:util"

import { NeuralAddressClassifier } from "@mailwoman/neural"

import { synthesizeBoundaryStressRow } from "../../corpus/src/synthesize-boundary-stress.ts"

const { values: args } = parseArgs({
	options: {
		model: { type: "string" },
		tokenizer: { type: "string" },
		"model-card": { type: "string" },
		n: { type: "string", default: "300" },
	},
})
const N = Number(args.n)

const norm = (s?: string) => (s ?? "").toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim()
const wordIncludes = (hay: string, needle: string) =>
	needle.length > 0 && new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay)

const classifier = await NeuralAddressClassifier.loadFromWeights(
	args.model
		? { locale: "en-US", modelPath: args.model, tokenizerPath: args.tokenizer, modelCardPath: args["model-card"] }
		: { locale: "en-US" }
)
const random = (() => {
	let a = 20260618 >>> 0

	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
})()

const mode: Record<string, number> = {}
const examples: string[] = []

for (let i = 0; i < N; i++) {
	const row = synthesizeBoundaryStressRow(undefined, { random, forceTemplate: "street-eats-affix" })
	const gold = norm(row.components.street_suffix)

	if (!gold) continue
	const p = (await classifier.parseJSON(row.raw)) as Record<string, string>
	let m: string

	if (norm(p.street_suffix) === gold) m = "✓ correct separate suffix span"
	else if (wordIncludes(norm(p.street), gold)) m = "merged INTO street (suffix not split out)"
	else if (!p.street_suffix) m = "dropped (no street_suffix, not in street)"
	else m = `other (suffix='${p.street_suffix}')`
	mode[m] = (mode[m] ?? 0) + 1

	if (examples.length < 6 && m.startsWith("merged"))
		examples.push(
			`  "${row.raw}"\n     gold: street='${row.components.street}' suffix='${row.components.street_suffix}' | got: street='${p.street ?? ""}' suffix='${p.street_suffix ?? ""}'`
		)
}

const total = Object.values(mode).reduce((a, b) => a + b, 0)
console.log(`\n== street-eats-affix B/I decode inspector — ${args.model ?? "dev"} (n=${total}) ==\n`)

for (const [m, c] of Object.entries(mode).sort((a, b) => b[1] - a[1]))
	console.log(`  ${((100 * c) / total).toFixed(0).padStart(3)}%  ${m}  (${c})`)

if (examples.length) console.log(`\n  examples (merged):\n${examples.join("\n")}`)
console.log()
