/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Score the boards the anchor-v2 retrain (`v4.2.0-base-anchor-v2`) pre-registered, replicating the
 *   instrument `docs/records/evals/2026-08-05-en-gb-anchor-off.md` used so the numbers are directly
 *   comparable to that record's.
 *
 *   THE INSTRUMENT, verbatim from that record: the production runtime pipeline
 *   (`createRuntimePipeline` with the classifier only — what `mailwoman parse` builds with no
 *   `--resolve` and no `MAILWOMAN_WOF_DB`), three registers per row (as-written / lowercase /
 *   UPPERCASE), graded as exact match on the tag's concatenated span folded to uppercase with
 *   whitespace stripped.
 *
 *   Boards:
 *
 *   - `gb` — `mailwoman/eval-harness/fixtures/gb-golden.jsonl` (120 rows; 106 carry a postcode, 69 carry
 *       a `dependent_locality`). Reports the postcode board (318 = 106 × 3), the `dependent_locality`
 *       board (207 = 69 × 3), and the same `dependent_locality` board with the input's commas STRIPPED
 *       — the third leg that record tracked as the cost of the anchor-off mitigation.
 *   - `us` / `fr` — the 100 US / 46 FR rows of `mailwoman/eval-harness/fixtures/parity-corpus.jsonl`,
 *       three registers each. Per-gold-tag exact match plus the sha256 of the full span serialization
 *       over all parses (the record's byte-stability instrument: identical hash = byte-identical
 *       parses).
 *
 *   `--cache-root` grades a candidate laid out as a package-shaped weights dir
 *   (`<cacheRoot>/node_modules/@mailwoman/neural-weights-<locale>`) — the `weightsCacheRoot` posture
 *   `parity-corpus.ts` documents, and the ONLY way to grade a candidate with its sibling channels fed.
 *   Omit it to grade the installed workspace package.
 *
 *   Usage: node packages/mailwoman/lib/dev-tools/score-anchor-v2-boards.run.ts --board gb --locale en-gb --cache-root <dir>
 */

import { groupTuplesByTag } from "@mailwoman/core/decoder"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { STREET_FAMILY_TAGS } from "@mailwoman/core/types"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { JSONSpliterator } from "spliterator"

import {
	type Board,
	emptyBoard,
	fold,
	REGISTERS,
	register,
	type Register,
	reportBoard,
} from "#dev-tools/register-board"
import { PARITY_FIXTURES_V1_PATH, type ParityFixture } from "#eval-harness/parity-corpus"
import { createRuntimePipeline } from "#index"

const { values } = parseArguments({
	options: {
		board: { type: "string", default: "gb" },
		locale: { type: "string" },
		"cache-root": { type: "string" },
		label: { type: "string", default: "candidate" },
		"dump-misses": { type: "string" },
		/**
		 * Dump the FULL per-row tag serialization. The ablation legs of a saturated board are indistinguishable by score —
		 * diffing this is how you tell "the channel changed nothing" from "the board cannot see it".
		 */
		"dump-spans": { type: "string" },
		/**
		 * Pin `normalizeCase: false` (#690/#829 OFF) — the register in which the shaped anchor keyer was measured DEAD:
		 * 0/120 gb-golden rows yield a shaped span on raw lowercase (#1512). With normalization ON (the default) the
		 * lowercase leg is rescued before the keyer ever sees it, so this flag is the only way to grade the KEYER's
		 * register-sensitivity rather than `normalizeInputCase`'s.
		 */
		"raw-case": { type: "boolean", default: false },
	},
})

const board = values.board!
const locale = values.locale ?? (board === "gb" ? "en-gb" : board === "fr" ? "fr-fr" : "en-us")

const classifier = await NeuralAddressClassifier.loadFromWeights({
	locale,
	...(values["cache-root"] ? { cacheRoot: values["cache-root"] } : {}),
})

const pipeline = createRuntimePipeline({ classifier, ...(values["raw-case"] ? { normalizeCase: false } : {}) })

interface Miss {
	register: Register
	input: string
	tag: string
	gold: string
	got: string
}

const misses: Miss[] = []
const spans: string[] = []

/**
 * One row's parse as a stable string — every tag it emitted, sorted. Two arms that produce identical files produced
 * byte-identical parses.
 */
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
	const rows = await Array.fromAsync(
		JSONSpliterator.fromAsync<{ raw: string; components: Record<string, string> }>(
			"packages/mailwoman/lib/eval-harness/fixtures/gb-golden.jsonl"
		)
	)

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

			// The comma-stripped leg: same rows, same gold, commas removed from the input.
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

	console.log(`\n=== gb-golden · ${values.label} · locale ${locale} · normalizeCase ${!values["raw-case"]} ===`)
	console.log("board                                   hit/total   per register")

	reportBoard("exact postcode", postcode)
	reportBoard("exact dependent_locality", depLoc)
	reportBoard("dependent_locality comma-STRIPPED", depLocCommaFree)
} else {
	const country = board.toUpperCase()

	const rows = (await Array.fromAsync(JSONSpliterator.fromAsync<ParityFixture>(PARITY_FIXTURES_V1_PATH))).filter(
		(row) => row.country === country
	)

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

				// The gold `street` is the whole street NAME; the model emits it as a family
				// (prefix/name/particle/suffix). `parity-corpus.ts`'s floor compares the assembled family, so a
				// bare tag-vs-tag read of `street` scores a correct parse as a miss. Assemble the same family.
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
	await writeLocalTextFile(spans.join("\n") + "\n", values["dump-spans"])

	console.log(`spans → ${values["dump-spans"]} (${spans.length} parses, sha256 ` + `${sha256Hex(spans.join("\n"))})`)
}

if (values["dump-misses"]) {
	await writeLocalTextFile(misses.map((m) => JSON.stringify(m)).join("\n") + "\n", values["dump-misses"])

	console.log(`misses → ${values["dump-misses"]} (${misses.length})`)
}
