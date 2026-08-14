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
 *   Usage: node mailwoman/dev-tools/gb-fragment-board.run.ts --cache-root <dir> --label <name>
 */

import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { decodeAsTuples } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createRuntimePipeline } from "mailwoman"
import { deriveGeocodeRegister } from "mailwoman/geocode-core"
import { JSONSpliterator } from "spliterator"

const REGISTERS = ["asis", "lower", "upper"] as const

type Register = (typeof REGISTERS)[number]

const { values } = parseArgs({
	options: {
		locale: { type: "string", default: "en-gb" },
		"cache-root": { type: "string" },
		label: { type: "string", default: "candidate" },
		fixtures: { type: "string", default: "packages/mailwoman/eval-harness/fixtures/gb-golden.jsonl" },
		"dump-spans": { type: "string" },
	},
})

const locale = values.locale!

/**
 * The grading fold, verbatim from `score-anchor-v2-boards.run.ts`: uppercase, all whitespace removed.
 */
const fold = (value: string): string => value.toUpperCase().replaceAll(/\s+/gu, "")

function register(text: string, reg: Register): string {
	return reg === "lower" ? text.toLowerCase() : reg === "upper" ? text.toUpperCase() : text
}

const classifier = await NeuralAddressClassifier.loadFromWeights({
	locale,
	...(values["cache-root"] ? { cacheRoot: values["cache-root"] } : {}),
})

const pipeline = createRuntimePipeline({ classifier })

const rows = await Array.fromAsync(
	JSONSpliterator.fromAsync<{ raw: string; components: Record<string, string> }>(values.fixtures!)
)

interface Board {
	hit: Record<Register, number>
	total: Record<Register, number>
	skipped: number
}

function emptyBoard(): Board {
	return { hit: { asis: 0, lower: 0, upper: 0 }, total: { asis: 0, lower: 0, upper: 0 }, skipped: 0 }
}

/**
 * The fragment shapes, each with the text it builds and the tag it is graded on.
 */
const SHAPES = [
	{
		name: "street fragment",
		tag: "street",
		build: (c: Record<string, string>) => (c.street ? [c.house_number, c.street].filter(Boolean).join(" ") : undefined),
		// The model emits the street as a FAMILY (prefix/name/particle/suffix); assemble it the way
		// `score-anchor-v2-boards.run.ts` does before comparing to the whole-name gold.
		emit: ["street_prefix", "street", "street_prefix_particle", "street_suffix"],
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
					board.skipped++
				}

				continue
			}

			const result = await pipeline(text, { locale })
			const byTag = new Map<string, string[]>()

			for (const [tag, value] of decodeAsTuples(result.tree)) {
				byTag.set(tag, [...(byTag.get(tag) ?? []), value])
			}

			spans.push(
				`${shape.name}\t${reg}\t${base}\t${[...byTag.entries()]
					.map(([tag, values_]) => `${tag}=${values_.join("|")}`)
					.toSorted()
					.join(";")}`
			)

			board.total[reg]++
			const got = shape.emit.flatMap((tag) => byTag.get(tag) ?? []).join(" ")
			const gold = shape.tag === "street" ? row.components.street! : row.components[shape.tag]!

			if (fold(got) === fold(gold)) {
				board.hit[reg]++
			}
		}
	}
}

console.log(`\n=== gb-golden FRAGMENT register · ${values.label} · locale ${locale} ===`)
console.log("board                                   hit/total   per register")

for (const shape of SHAPES) {
	const board = boards.get(shape.name)!
	const hit = REGISTERS.reduce((sum, r) => sum + board.hit[r], 0)
	const total = REGISTERS.reduce((sum, r) => sum + board.total[r], 0)

	console.log(
		`${shape.name.padEnd(34)} ${`${hit}/${total}`.padStart(9)}   ` +
			REGISTERS.map((r) => `${r} ${board.hit[r]}/${board.total[r]}`).join(" · ") +
			(board.skipped ? `  · ${board.skipped} rows skipped (register was not fragmented)` : "")
	)
}

console.log(`span serialization sha256: ${createHash("sha256").update(spans.join("\n")).digest("hex")}`)

if (values["dump-spans"]) {
	writeFileSync(values["dump-spans"], spans.join("\n") + "\n")

	console.log(`spans → ${values["dump-spans"]} (${spans.length} parses)`)
}
