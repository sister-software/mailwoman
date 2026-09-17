/**
 * What a script-reading router does to the regression board's CJK-containing rows (#2282, #2305).
 *
 * `scriptFamilyForText` once routed on the FOLDED character class alone, so only an input that was CJK end to end
 * reached the character model and every mixed input went to the Latin one — which is how `逊克二分场四队, HEILONGJIANG, CHINA`
 * came back as a single locality holding the whole Han unit. The question was never whether reading the per-span script
 * helps the Chinese rows; it is what it does to a Latin address that happens to carry a Han venue name.
 *
 * Two candidate rules are measured against the same rows, beside what the shipped router does today (`routedToday`):
 *
 * - `presence` — any CJK script anywhere in the input names the family. This is the rule the issue proposed.
 * - `segment` — a comma SEGMENT written wholly in a CJK script names it. A Han name inside a Latin line does not, because
 *   the line it sits in is not written in that script. This is the rule the router ships (`carriesFamilySegment`), so
 *   the rows it lists as newly routed are the ones a whole-input fold would still send to the Latin model.
 *
 * WHAT THIS MEASURES IS THE CLASSIFIER, NOT THE PIPELINE. Each arm calls `parse` directly, so normalization, the phrase
 * grouper and the resolver are all absent and the absolute scores here are not the board's. Both arms run through the
 * identical harness, so the COMPARISON is sound and the direction is what the probe reports.
 *
 * Run:
 *
 *     node packages/mailwoman/lib/dev-tools/cjk/script-routing-arm.run.ts
 *     node packages/mailwoman/lib/dev-tools/cjk/script-routing-arm.run.ts --out-json <path>
 */

import { decodeAsJSON, type AddressTree } from "@mailwoman/core/decoder"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { carriesFamilySegment, FAMILY_SCRIPTS, NeuralAddressClassifier, scriptFamilyForText } from "@mailwoman/neural"
import { computeQueryShape, type QueryShape } from "@mailwoman/query-shape"

import { loadRegressionCases } from "#eval-harness/gauntlet/cases/load"

const { values } = parseArguments({
	options: { "out-json": { type: "string" } },
})

/**
 * An input that would warm the family classifier, so both arms hold a loaded model before the first row is timed.
 */
const FAMILY_WARMUP = "東京都千代田区"

/**
 * Whether any span of the input is written in a script the family serves.
 */
function carriesFamilyScript(shape: QueryShape): boolean {
	return (shape.scripts ?? []).some((entry) => FAMILY_SCRIPTS.has(entry.script))
}

/**
 * How many of a row's asserted components the parse got, and how many it asserted.
 *
 * Graded through `decodeAsJSON`, which is the projection the board's `expectComponents` is written against — a local
 * tree walk here would be a second answer to the same question and would drift from the one the board uses.
 */
function agreement(tree: AddressTree, want: Record<string, string> | undefined): [number, number] {
	if (!want) return [0, 0]
	const got = decodeAsJSON(tree) as Record<string, string>
	const keys = Object.keys(want)

	return [keys.filter((key) => got[key] === want[key]).length, keys.length]
}

const routed = await NeuralAddressClassifier.loadRoutedFromWeights({ locale: "en-US" })
const primary = routed.primary
const family = await routed.forInput(FAMILY_WARMUP)

if (family === primary) {
	throw new Error("the character-path family did not load — both arms would be the same model")
}

interface ArmRow {
	id: string
	country?: string
	input: string
	characterClass?: string
	familyShare: number
	routedToday: boolean
	underPresence: boolean
	underSegment: boolean
	latin: [number, number]
	character: [number, number]
}

const rows: ArmRow[] = []

for (const board of await loadRegressionCases()) {
	const shape = computeQueryShape(board.input)

	if (!carriesFamilyScript(shape)) continue

	const routedToday = Boolean(scriptFamilyForText(board.input))
	const want = board.expectComponents as Record<string, string> | undefined

	rows.push({
		id: board.id,
		...(board.country ? { country: board.country } : {}),
		input: board.input,
		characterClass: shape.characterClass,
		familyShare: (shape.scripts ?? [])
			.filter((entry) => FAMILY_SCRIPTS.has(entry.script))
			.reduce((sum, entry) => sum + entry.share, 0),
		routedToday,
		underPresence: true,
		underSegment: carriesFamilySegment(shape),
		latin: agreement(await primary.parse(board.input), want),
		character: agreement(await family.parse(board.input), want),
	})
}

/**
 * What a rule costs and provides over the rows it newly routes: a row whose character-model agreement is higher is a
 * gain, lower is a regression, equal is neither.
 */
function verdict(newlyRouted: ArmRow[]): { gained: number; regressed: number; unchanged: number } {
	let gained = 0
	let regressed = 0
	let unchanged = 0

	for (const row of newlyRouted) {
		if (row.character[0] > row.latin[0]) {
			gained++
		} else if (row.character[0] < row.latin[0]) {
			regressed++
		} else {
			unchanged++
		}
	}

	return { gained, regressed, unchanged }
}

const unrouted = rows.filter((row) => !row.routedToday)
const presence = unrouted
const segment = unrouted.filter((row) => row.underSegment)

console.log(`#2282 script-routing arm — ${rows.length} board rows carry a script the character family serves`)
console.log(`${rows.length - unrouted.length} of them route to it today; ${unrouted.length} do not\n`)
console.log(`| row | family share | latin | character |`)
console.log(`| --- | ---: | ---: | ---: |`)

for (const row of unrouted) {
	const mark = row.underSegment ? "" : "  ← no wholly-family segment"

	console.log(
		`| ${row.country ?? "—"} ${row.id} | ${row.familyShare.toFixed(2)} | ${row.latin[0]}/${row.latin[1]} | ${row.character[0]}/${row.character[1]} |${mark}`
	)
}

for (const [name, set] of [
	["presence — any family script in the input", presence],
	["segment — a comma segment wholly in one", segment],
] as const) {
	const { gained, regressed, unchanged } = verdict([...set])

	console.log(
		`\n${name}: routes ${set.length} more rows — ${gained} gained, ${regressed} regressed, ${unchanged} level`
	)

	for (const row of set.filter((entry) => entry.character[0] < entry.latin[0])) {
		console.log(`  regressed ${row.latin[0]}/${row.latin[1]} → ${row.character[0]}/${row.character[1]}: ${row.input}`)
	}
}

if (values["out-json"]) {
	await writeLocalJSONFile({ rows, presence: verdict(presence), segment: verdict(segment) }, values["out-json"])

	console.log(`\nwrote ${values["out-json"]}`)
}
