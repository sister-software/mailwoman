/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Does the comma-free register still find the locality? A rate rather than an anecdote.
 *
 *   This walks every fixture row with both `street` and `locality` fields. It drops commas and asks
 *   whether the gold locality still lands in the locality slot, so the question becomes a measurement with
 *   a denominator.
 *
 *   Runs the raw classifier (`--raw`, what `eval-harness/invariance/runner.ts` grades) or the production
 *   runtime pipeline (default). The two disagree: the raw path never runs `@mailwoman/normalize`, so
 *   case normalization is absent and the register legs see different text.
 *
 *   Usage:
 *     node packages/mailwoman/tools/dev-tools/probe/comma-free-locality.run.ts --cache-root <dir> --label cand --country FR
 */

import { groupTuplesByTag } from "@mailwoman/core/decoder"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { JSONSpliterator } from "spliterator"

import { createRuntimePipeline } from "#index"
import { fold } from "#tools/dev-tools/register-board"
import { PARITY_FIXTURES_V1_PATH, type ParityFixture } from "#tools/eval-harness/parity-corpus"

const { values } = parseArguments({
	options: {
		"cache-root": { type: "string" },
		label: { type: "string", default: "arm" },
		locale: { type: "string", default: "en-US" },
		country: { type: "string" },
		raw: { type: "boolean", default: false },
		fixtures: { type: "string", default: PARITY_FIXTURES_V1_PATH },
		verbose: { type: "boolean", default: false },
	},
})

const rows = JSONSpliterator.fromAsync<ParityFixture>(values.fixtures!)
	.filter((row) => (values.country ? row.country === values.country : true))
	// The shape the claim is about: both a street and a locality, separated by at least one comma.
	.filter((row) => row.expect?.locality?.length && row.expect?.street?.length && row.input.includes(","))

const classifier = await NeuralAddressClassifier.loadFromWeights({
	locale: values.locale!,
	...(values["cache-root"] ? { cacheRoot: values["cache-root"] } : {}),
})

const pipeline = createRuntimePipeline({ classifier })

async function tagsFor(text: string): Promise<Map<string, string[]>> {
	const tree = values.raw ? await classifier.parse(text) : (await pipeline(text, { locale: values.locale! })).tree

	return groupTuplesByTag(tree)
}

let withComma = 0
let withoutComma = 0
let rowCount = 0
const lost: string[] = []

for await (const row of rows) {
	rowCount++
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
	`${values.label.padEnd(10)} ${values.raw ? "raw   " : "pipe  "} n=${rowCount}  ` +
		`locality WITH commas ${withComma}/${rowCount}  COMMA-FREE ${withoutComma}/${rowCount}  ` +
		`lost-by-comma-drop ${lost.length}`
)

if (values.verbose && lost.length) {
	console.log(lost.join("\n"))
}
