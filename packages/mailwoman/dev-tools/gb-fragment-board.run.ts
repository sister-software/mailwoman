/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A GB board in the FRAGMENT register — the one register that can see the Option-A evidence bundle.
 *
 *   WHY IT HAD TO EXIST. Restoring the evidence channels to the en-gb overlay (#1511, ROAD_TO_V9 §1 A4)
 *   is a default-on change, so the D-rule wants a before/after on GB. Run against `gb-golden.jsonl`
 *   through the production pipeline, the two arms come back BYTE-IDENTICAL — same span sha256, all
 *   three boards unmoved. That is not evidence of safety: every gb-golden row is a full address, the
 *   kind classifier calls it `formatted`, and the register gate (Decision A, `classifier.ts`'s
 *   `evidenceOn`) withholds BOTH evidence channels in that register by design. The board is blind to
 *   the change by construction, and reporting its byte-identity as a pass would be reporting the
 *   instrument, not the model.
 *
 *   So this projects each gb-golden row onto the register where the channels are live. Two fragment
 *   shapes per row, both drawn from the row's own gold components so the grading stays exact-match:
 *
 *   - `street` — the street line alone (`components.street`, house number prefixed when the row has one).
 *     The street-type channel's own register.
 *   - `place` — `dependent_locality, locality`. The locality-surface channel's register, and the one
 *     the shipped bundle's homonym wins were measured in.
 *
 *   Rows whose fragment does not classify as `fragmented` are SKIPPED and counted, not silently graded
 *   in the wrong register — the mistake this file exists to correct.
 *
 *   Usage: node packages/mailwoman/dev-tools/gb-fragment-board.run.ts --cache-root <dir> --label <name>
 */

import { groupTuplesByTag } from "@mailwoman/core/decoder"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { STREET_FAMILY_TAGS } from "@mailwoman/core/types"
import { sha256Hex } from "@mailwoman/core/utils/hash"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { JSONSpliterator } from "spliterator"

import { type Board, emptyBoard, fold, REGISTERS, register, reportBoard } from "#dev-tools/register-board"
import { deriveGeocodeRegister } from "#geocode-core"
import { createRuntimePipeline } from "#index"

const { values } = parseArguments({
	options: {
		locale: { type: "string", default: "en-gb" },
		"cache-root": { type: "string" },
		label: { type: "string", default: "candidate" },
		fixtures: { type: "string", default: "packages/mailwoman/eval-harness/fixtures/gb-golden.jsonl" },
		"dump-spans": { type: "string" },
	},
})

const locale = values.locale!

const classifier = await NeuralAddressClassifier.loadFromWeights({
	locale,
	...(values["cache-root"] ? { cacheRoot: values["cache-root"] } : {}),
})

const pipeline = createRuntimePipeline({ classifier })

const rows = await Array.fromAsync(
	JSONSpliterator.fromAsync<{ raw: string; components: Record<string, string> }>(values.fixtures!)
)

/**
 * The fragment shapes, each with the text it builds and the tag it is graded on.
 */
const SHAPES = [
	{
		name: "street fragment",
		tag: "street",
		build: (c: Record<string, string>) =>
			c.street ? [c.house_number, c.street].filter((part) => part != null && part.length > 0).join(" ") : undefined,
		// The model emits the street as a FAMILY (prefix/name/particle/suffix); assemble it the way
		// `score-anchor-v2-boards.run.ts` does before comparing to the whole-name gold.
		emit: STREET_FAMILY_TAGS,
	},
	{
		name: "place-pair fragment",
		tag: "dependent_locality",
		build: (c: Record<string, string>) =>
			c.dependent_locality && c.locality ? `${c.dependent_locality}, ${c.locality}` : undefined,
		emit: ["dependent_locality"],
	},
] as const

const boards = new Map<string, Board>(SHAPES.map((shape) => [shape.name, emptyBoard()]))
const skippedByShape = new Map<string, number>()
const spans: string[] = []

for (const shape of SHAPES) {
	const board = boards.get(shape.name)!

	for (const reg of REGISTERS) {
		for (const row of rows) {
			const base = shape.build(row.components)

			if (!base) continue
			const text = register(base, reg)

			// The register is the whole point — grade only where the channels are actually live.
			if (deriveGeocodeRegister(text) !== "fragmented") {
				if (reg === "asis") {
					skippedByShape.set(shape.name, (skippedByShape.get(shape.name) ?? 0) + 1)
				}

				continue
			}

			const result = await pipeline(text, { locale })
			const byTag = groupTuplesByTag(result.tree)

			spans.push(
				`${shape.name}\t${reg}\t${base}\t${[...byTag.entries()]
					.map(([tag, values_]) => `${tag}=${values_.join("|")}`)
					.toSorted()
					.join(";")}`
			)

			board.perRegister[reg].total++
			const got = shape.emit.flatMap((tag) => byTag.get(tag) ?? []).join(" ")
			const gold = shape.tag === "street" ? row.components.street! : row.components[shape.tag]!

			if (fold(got) === fold(gold)) {
				board.perRegister[reg].hit++
			}
		}
	}
}

console.log(`\n=== gb-golden FRAGMENT register · ${values.label} · locale ${locale} ===`)
console.log("board                                   hit/total   per register")

for (const shape of SHAPES) {
	const skipped = skippedByShape.get(shape.name) ?? 0

	reportBoard(
		shape.name,
		boards.get(shape.name)!,
		skipped ? `  · ${skipped} rows skipped (register was not fragmented)` : ""
	)
}

console.log(`span serialization sha256: ${sha256Hex(spans.join("\n"))}`)

if (values["dump-spans"]) {
	await writeLocalTextFile(spans.join("\n") + "\n", values["dump-spans"])

	console.log(`spans → ${values["dump-spans"]} (${spans.length} parses)`)
}
