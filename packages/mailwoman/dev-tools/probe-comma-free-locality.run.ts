/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Does the comma-free register still find the locality? A RATE, not an anecdote.
 *
 *   Built for the v4.2.0-base-anchor-v2 (Run B) triage. The invariance suite reported ONE new comma-drop
 *   LOST (`fr-montmartre`, `street: "Montmartre" -> "Montmartre Paris"`), while the metamorphic layer
 *   reported the SAME transform on the SAME shape newly PASSING (`181 Rue du Chevaleret, Paris`). One row
 *   each way is churn, not a capability claim, and neither number can settle the other. This walks every
 *   fixture row that carries both a `street` and a `locality`, drops the commas, and asks whether the gold
 *   locality still lands in the locality slot — so "the comma-free register regressed" becomes a
 *   measurement with a denominator.
 *
 *   Runs the RAW classifier (`--raw`, what `eval-harness/invariance/runner.ts` grades) or the production
 *   runtime pipeline (default). The two disagree: the raw path never runs `@mailwoman/normalize`, so #690
 *   case normalization is absent and the register legs see different text.
 *
 *   Usage:
 *     node mailwoman/dev-tools/probe-comma-free-locality.run.ts --cache-root <dir> --label cand --country FR
 */

import { parseArgs } from "node:util"

import { decodeAsTuples } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createRuntimePipeline } from "mailwoman"
import { JSONSpliterator } from "spliterator"

const { values } = parseArgs({
	options: {
		"cache-root": { type: "string" },
		label: { type: "string", default: "arm" },
		locale: { type: "string", default: "en-US" },
		country: { type: "string" },
		raw: { type: "boolean", default: false },
		fixtures: { type: "string", default: "packages/mailwoman/eval-harness/fixtures/parity-corpus.jsonl" },
		verbose: { type: "boolean", default: false },
	},
})

interface Row {
	id: string
	input: string
	country: string
	expect?: Record<string, string[]>
}

const rows = (await Array.fromAsync(JSONSpliterator.fromAsync<Row>(values.fixtures!)))
	.filter((r) => (values.country ? r.country === values.country : true))
	// The shape the claim is about: a street AND a locality, separated by at least one comma.
	.filter((r) => r.expect?.locality?.length && r.expect?.street?.length && r.input.includes(","))

const classifier = await NeuralAddressClassifier.loadFromWeights({
	locale: values.locale!,
	...(values["cache-root"] ? { cacheRoot: values["cache-root"] } : {}),
})

const pipeline = createRuntimePipeline({ classifier })
const fold = (v: string): string => v.toUpperCase().replaceAll(/\s+/gu, "")

async function tagsFor(text: string): Promise<Map<string, string[]>> {
	const tree = values.raw ? await classifier.parse(text) : (await pipeline(text, { locale: values.locale! })).tree
	const byTag = new Map<string, string[]>()

	for (const [tag, value] of decodeAsTuples(tree)) {
		byTag.set(tag, [...(byTag.get(tag) ?? []), value])
	}

	return byTag
}

let withComma = 0
let withoutComma = 0
const lost: string[] = []

for (const row of rows) {
	const gold = fold(row.expect!.locality!.join(""))
	// Verbatim `eval-harness/invariance/transforms.ts::commaDrop`.
	const stripped = row.input.replaceAll(",", "").replaceAll(/\s+/gu, " ").trim()

	const a = await tagsFor(row.input)
	const b = await tagsFor(stripped)

	const hitA = fold((a.get("locality") ?? []).join("")) === gold
	const hitB = fold((b.get("locality") ?? []).join("")) === gold

	if (hitA) {
		withComma++
	}

	if (hitB) {
		withoutComma++
	}

	if (hitA && !hitB) {
		lost.push(`    ${row.id}  "${stripped}"  locality=${(b.get("locality") ?? ["∅"]).join("|")}`)
	}
}

console.log(
	`${values.label.padEnd(10)} ${values.raw ? "raw   " : "pipe  "} n=${rows.length}  ` +
		`locality WITH commas ${withComma}/${rows.length}  COMMA-FREE ${withoutComma}/${rows.length}  ` +
		`lost-by-comma-drop ${lost.length}`
)

if (values.verbose && lost.length) {
	console.log(lost.join("\n"))
}
