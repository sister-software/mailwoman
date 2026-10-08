/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { STREET_FAMILY_TAGS } from "@mailwoman/codex/component"
import { groupTuplesByTag } from "@mailwoman/core/decoder"
import { writeLocalTextFile, writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { caseNormalizationOf, DEFAULT_CASE_NORMALIZATION } from "@mailwoman/core/pipeline"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { JSONSpliterator } from "spliterator"

import { createRuntimePipeline } from "#index"
import {
	type Board,
	emptyBoard,
	fold,
	REGISTERS,
	register,
	type Register,
	reportBoard,
} from "#tools/dev-tools/register-board"
import { PARITY_FIXTURES_V1_PATH, type ParityFixture } from "#tools/eval-harness/parity-corpus"

const { values } = parseArguments({
	options: {
		board: { type: "string", default: "gb" },
		locale: { type: "string" },
		"cache-root": { type: "string" },
		label: { type: "string", default: "candidate" },
		"dump-misses": { type: "string" },
		"dump-spans": { type: "string" },
		/**
		 * With normalization on the lowercase leg is rescued before the shaped anchor keyer sees it,
		 * so this flag is the only way to grade the keyer's register-sensitivity.
		 */
		"case-normalization": { type: "string", default: DEFAULT_CASE_NORMALIZATION },
	},
})

const board = values.board!
const locale = values.locale ?? (board === "gb" ? "en-gb" : board === "fr" ? "fr-fr" : "en-us")

const classifier = await NeuralAddressClassifier.loadFromWeights({
	locale,
	...(values["cache-root"] ? { cacheRoot: values["cache-root"] } : {}),
})

const caseNormalization = caseNormalizationOf(values["case-normalization"])
const pipeline = createRuntimePipeline({ classifier, caseNormalization })

interface Miss {
	register: Register
	input: string
	tag: string
	gold: string
	got: string
}

const misses: Miss[] = []
const spans: string[] = []

function serializeTags(key: string, byTag: Map<string, string[]>): string {
	return `${key}\t${[...byTag.entries()]
		.map(([tag, values_]) => `${tag}=${values_.join("|")}`)
		.toSorted()
		.join(";")}`
}

async function tagsFor(text: string): Promise<Map<string, string[]>> {
	const result = await pipeline(text, { locale })

	return groupTuplesByTag(result.tree)
}

if (board === "gb") {
	const rows = await JSONSpliterator.fromAsync<{ raw: string; components: Record<string, string> }>(
		"packages/mailwoman/tools/eval-harness/fixtures/gb-golden.jsonl"
	).toArray()

	const postcode = emptyBoard()
	const depLoc = emptyBoard()
	const depLocCommaFree = emptyBoard()

	for (const reg of REGISTERS) {
		for (const row of rows) {
			const text = register(row.raw, reg)
			const byTag = await tagsFor(text)
			spans.push(serializeTags(`${reg}\t${row.raw}`, byTag))

			for (const [tag, b] of [
				["postcode", postcode],
				["dependent_locality", depLoc],
			] as const) {
				const gold = row.components[tag]

				if (!gold) continue

				b.perRegister[reg].total++
				const got = (byTag.get(tag) ?? []).join(" ")

				if (fold(got) === fold(gold)) {
					b.perRegister[reg].hit++
				} else {
					misses.push({ register: reg, input: text, tag, gold, got })
				}
			}

			const gold = row.components.dependent_locality

			if (!gold) continue
			const stripped = text.replaceAll(",", "").replaceAll(/\s+/gu, " ").trim()
			const strippedTags = await tagsFor(stripped)
			spans.push(serializeTags(`${reg}-commafree\t${row.raw}`, strippedTags))

			depLocCommaFree.perRegister[reg].total++
			const got = (strippedTags.get("dependent_locality") ?? []).join(" ")

			if (fold(got) === fold(gold)) {
				depLocCommaFree.perRegister[reg].hit++
			} else {
				misses.push({ register: reg, input: stripped, tag: "dependent_locality (comma-free)", gold, got })
			}
		}
	}

	console.log(`\n=== gb-golden · ${values.label} · locale ${locale} · caseNormalization ${caseNormalization} ===`)
	console.log("board                                   hit/total   per register")

	reportBoard("exact postcode", postcode)
	reportBoard("exact dependent_locality", depLoc)
	reportBoard("dependent_locality comma-STRIPPED", depLocCommaFree)
} else {
	const country = board.toUpperCase()

	const rows = await JSONSpliterator.fromAsync<ParityFixture>(PARITY_FIXTURES_V1_PATH)
		.filter((row) => row.country === country)
		.toArray()

	const boards = new Map<string, Board>()
	const serialization: string[] = []

	for (const reg of REGISTERS) {
		for (const row of rows) {
			const text = register(row.input, reg)
			const byTag = await tagsFor(text)

			serialization.push(serializeTags(`${row.id}\t${reg}`, byTag))
			spans.push(serializeTags(`${reg}\t${row.id}`, byTag))

			for (const [tag, gold] of Object.entries(row.expect ?? {})) {
				if (!gold.length) continue

				// The gold `street` contains the whole street name.
				// The model emits a family of tags.
				// `parity-corpus.ts` compares the assembled family, so a bare tag-to-tag comparison misses.
				const emitted =
					tag === "street" ? STREET_FAMILY_TAGS.flatMap((t) => byTag.get(t) ?? []) : (byTag.get(tag) ?? [])

				const b = boards.get(tag) ?? emptyBoard()
				boards.set(tag, b)

				b.perRegister[reg].total++
				const got = emitted.join(" ")

				if (fold(got) === fold(gold.join(" "))) {
					b.perRegister[reg].hit++
				} else {
					misses.push({ register: reg, input: text, tag, gold: gold.join(" "), got })
				}
			}
		}
	}

	console.log(`\n=== ${country} parity board · ${values.label} · locale ${locale} · ${rows.length} rows × 3 ===`)
	console.log("tag                                     hit/total   per register")

	for (const tag of [...boards.keys()].toSorted()) {
		reportBoard(tag, boards.get(tag)!)
	}

	const hit = [...boards.values()].reduce((sum, b) => sum + REGISTERS.reduce((s, r) => s + b.perRegister[r].hit, 0), 0)

	const total = [...boards.values()].reduce(
		(sum, b) => sum + REGISTERS.reduce((s, r) => s + b.perRegister[r].total, 0),
		0
	)

	console.log(`${"ALL TAGS".padEnd(34)} ${`${hit}/${total}`.padStart(9)}`)

	console.log(
		`span serialization sha256: ${sha256Hex(serialization.join("\n"))}  ` + `(${rows.length * REGISTERS.length} parses)`
	)
}

if (values["dump-spans"]) {
	await writeLocalTextFile(spans, values["dump-spans"])

	console.log(`spans → ${values["dump-spans"]} (${spans.length} parses, sha256 ` + `${sha256Hex(spans.join("\n"))})`)
}

if (values["dump-misses"]) {
	await writeLocalJSONLFile(misses, values["dump-misses"])

	console.log(`misses → ${values["dump-misses"]} (${misses.length})`)
}
