/**
 * Compares the Latin and character models on regression-board rows that contain a CJK script,
 * for the rows the shipped router does not send to the character model.
 *
 * The probe scores two routing rules over those rows:
 *
 * - `presence` routes an input when any span uses a CJK script.
 * - `segment` routes an input when one comma segment is written wholly in a CJK script.
 *   The router ships this rule as `carriesFamilySegment`.
 *
 * Each arm calls `parse` directly and skips normalization, phrase grouping
 * and resolution, so the absolute scores differ from the board's.
 * The comparison between arms is still valid.
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
 * Routes to the character family, which loads that model before the first row.
 */
const FAMILY_WARMUP = "東京都千代田区"

/**
 * Reports whether any span of the input uses a script the character family serves.
 */
function carriesFamilyScript(shape: QueryShape): boolean {
	return (shape.scripts ?? []).some((entry) => FAMILY_SCRIPTS.has(entry.script))
}

/**
 * Returns the number of expected components the parse matched and the number expected.
 *
 * Grading uses `decodeAsJSON` because the board's `expectComponents` is written against that projection.
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
 * Counts the newly routed rows where the character model matches more, fewer
 * or the same components as the Latin model.
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
