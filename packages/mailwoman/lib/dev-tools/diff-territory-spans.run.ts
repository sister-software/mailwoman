/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dump classifier spans for a supplied row set and selected text registers, allowing line-by-line comparison
 *   between model arms. Use `--rows` with `id<TAB>input` lines; blank lines and `#` comments are ignored.
 */

import { groupTuplesByTag } from "@mailwoman/core/decoder"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { TextSpliterator } from "spliterator"

import { REGISTERS as BASE_REGISTERS, register } from "#dev-tools/register-board"
import { createRuntimePipeline } from "#index"

const REGISTERS = [...BASE_REGISTERS, "comma-drop"] as const

type Register = (typeof REGISTERS)[number]

const { values } = parseArguments({
	options: {
		rows: { type: "string" },
		"cache-root": { type: "string" },
		label: { type: "string", default: "arm" },
		locale: { type: "string", default: "en-US" },
		registers: { type: "string", default: "asis,lower,upper,comma-drop" },
		/**
		 * Use `classifier.parse` directly instead of the normalization pipeline.
		 */
		raw: { type: "boolean", default: false },
	},
})

const locale = values.locale!
const selected = new Set(values.registers!.split(",")) as Set<Register>

function applyRegister(text: string, reg: Register): string {
	if (reg === "comma-drop") {
		// Match the invariance suite's comma-drop transform, including whitespace collapse.
		return text.replaceAll(",", "").replaceAll(/\s+/gu, " ").trim()
	}

	return register(text, reg)
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
		const byTag = groupTuplesByTag(tree)

		const serialized = [...byTag.entries()]
			.map(([tag, vals]) => `${tag}=${vals.join("|")}`)
			.toSorted()
			.join("; ")

		console.log(`${values.label}\t${row.id}\t${reg}\t${serialized}`)
	}
}
