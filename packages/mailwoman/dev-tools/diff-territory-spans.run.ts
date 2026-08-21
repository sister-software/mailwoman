/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Span-level parse dump for a named row set under ONE weights arm, so two arms can be diffed line for
 *   line. Built for the v4.2.0-base-anchor-v2 (Run B) regression triage: the gauntlet reports a COORD or a
 *   single-tag miss, which cannot distinguish "the parse moved" from "the resolver ranked differently".
 *   This dumps the parse alone (classifier-only pipeline, no resolver, exactly the gauntlet's parse half).
 *
 *   Registers are the invariance suite's own transforms, so a row can be read across the register axis the
 *   #690 case-normalization work made load-bearing: `asis` / `lower` / `upper` / `comma-drop`.
 *
 *   Usage:
 *     node packages/mailwoman/dev-tools/diff-territory-spans.run.ts --rows <file.txt> --cache-root <dir> --label cand-on
 *
 *   `--rows` is a plain text file of `id<TAB>input` lines (blank lines and `#` comments skipped).
 */

import { parseArgs } from "node:util"

import { decodeAsTuples } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { TextSpliterator } from "spliterator"

import { createRuntimePipeline } from "#index"

const REGISTERS = ["asis", "lower", "upper", "comma-drop"] as const

type Register = (typeof REGISTERS)[number]

const { values } = parseArgs({
	options: {
		rows: { type: "string" },
		"cache-root": { type: "string" },
		label: { type: "string", default: "arm" },
		locale: { type: "string", default: "en-US" },
		registers: { type: "string", default: "asis,lower,upper,comma-drop" },
		/**
		 * Parse through the RAW classifier (`classifier.parse`) instead of `createRuntimePipeline`. This is what
		 * `mailwoman/eval-harness/invariance/runner.ts`'s `buildParseFn` does, and the two instruments do NOT agree: the
		 * raw path skips `@mailwoman/normalize` entirely, so #690 case normalization never runs and the register legs see
		 * genuinely different text.
		 */
		raw: { type: "boolean", default: false },
	},
})

const locale = values.locale!
const selected = new Set(values.registers!.split(",")) as Set<Register>

function applyRegister(text: string, reg: Register): string {
	switch (reg) {
		case "lower":
			return text.toLowerCase()
		case "upper":
			return text.toUpperCase()
		case "comma-drop":
			// Verbatim `mailwoman/eval-harness/invariance/transforms.ts::commaDrop` — the whitespace collapse matters.
			return text.replaceAll(",", "").replaceAll(/\s+/gu, " ").trim()
		default:
			return text
	}
}

const rows = await TextSpliterator.fromAsync(values.rows!)
	.map((line) => line.trim())
	.filter((line) => line.length && !line.startsWith("#"))
	.map((line) => {
		const tab = line.indexOf("\t")

		return { id: line.slice(0, tab), input: line.slice(tab + 1) }
	})
	.toArray()

const classifier = await NeuralAddressClassifier.loadFromWeights({
	locale,
	...(values["cache-root"] ? { cacheRoot: values["cache-root"] } : {}),
})

const pipeline = createRuntimePipeline({ classifier })

for (const row of rows) {
	for (const reg of REGISTERS) {
		if (!selected.has(reg)) continue

		const text = applyRegister(row.input, reg)
		const tree = values.raw ? await classifier.parse(text) : (await pipeline(text, { locale })).tree
		const byTag = new Map<string, string[]>()

		for (const [tag, value] of decodeAsTuples(tree)) {
			byTag.set(tag, [...(byTag.get(tag) ?? []), value])
		}

		const serialized = [...byTag.entries()]
			.map(([tag, vals]) => `${tag}=${vals.join("|")}`)
			.toSorted()
			.join("; ")

		console.log(`${values.label}\t${row.id}\t${reg}\t${serialized}`)
	}
}
