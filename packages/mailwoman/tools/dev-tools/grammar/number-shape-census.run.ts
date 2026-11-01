/**
 * Threshold-free, report-only census of three number-shape detectors over the committed Gauntlet board.
 *
 * Each board row's expected components are located in its input, and every located
 * component whose value holds a digit is read by three detectors:
 *
 * - `postcode-syntax`: the row country's postcode format from `@mailwoman/postcode/country-formats`,
 *   with the prefix its layout prints (`HR-`, `MD-`) removed, accepts the whole value.
 *   It reads `postcode`.
 * - `range`: the value is two numbers joined by a hyphen or dash, as in `4-5` and `18 - 20`.
 *   It reads `house_number`.
 * - `unit-shape`: a row of `@mailwoman/codex/unit-shapes`, such as Singapore's
 *   `#09-71`, matches the whole value.
 *   It reads `unit`.
 *
 * A firing is explained when the expected component has the tag the detector reads,
 * and falsely flagged otherwise.
 * The census reads no model output, so it grades each detector against the board's expected
 * components only, as `docs/engineering/reference/decoder-grammar.mdx` §5 requires
 * before a detector becomes a decode-time term.
 *
 * It also records each value's class-run signature (`D5`, `D2-D3`, `A1D1 D1A2`).
 *
 * This command changes no runtime behavior and is not a release eval.
 */

import { UNIT_SHAPES } from "@mailwoman/codex/unit-shapes"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { acceptPostcode } from "@mailwoman/postcode/country-formats"

import { loadRegressionCases } from "#tools/eval-harness/gauntlet/cases/load"
import { locateUniqueComponentTruth } from "#tools/eval-harness/grammar/census"

const { values } = parseArguments({ options: { "out-json": { type: "string" } } })

const RANGE = /^\d+[A-Za-z]?\s*[-–]\s*\d+[A-Za-z]?$/u

const UNIT_SHAPE_WHOLE = UNIT_SHAPES.map((shape) => ({
	label: shape.label,
	re: new RegExp(`^(?:${shape.pattern})$`, "u"),
}))

const DETECTORS = {
	"postcode-syntax": {
		reads: "postcode",
		fires: (value: string, country: string) => acceptPostcode(value, country) != null,
	},
	range: { reads: "house_number", fires: (value: string) => RANGE.test(value) },
	"unit-shape": { reads: "unit", fires: (value: string) => UNIT_SHAPE_WHOLE.some((shape) => shape.re.test(value)) },
} as const

type DetectorName = keyof typeof DETECTORS

/**
 * The class-run signature of a value: `D` for a digit run, `A` for a letter run,
 * each with its length, and every other character as written.
 */
function classRunSignature(value: string): string {
	return value.replaceAll(/\d+|\p{L}+/gu, (run) => `${/\d/u.test(run) ? "D" : "A"}${run.length}`)
}

const cases = await loadRegressionCases()

const tally = Object.fromEntries(
	Object.keys(DETECTORS).map((name) => [name, { fired: 0, explained: 0, falselyFlagged: {} as Record<string, number> }])
) as Record<DetectorName, { fired: number; explained: number; falselyFlagged: Record<string, number> }>

const missed: Record<string, number> = {}
const falseFlags: Array<{ id: string; input: string; detector: DetectorName; tag: string; value: string }> = []
const signatures: Record<string, Record<string, number>> = {}
let valuesRead = 0

for (const row of cases) {
	for (const span of locateUniqueComponentTruth(row.input, row.expectComponents ?? {})) {
		if (!/\d/u.test(span.value)) continue

		valuesRead++
		const signature = classRunSignature(span.value)
		const bySignature = (signatures[span.tag] ??= {})

		bySignature[signature] = (bySignature[signature] ?? 0) + 1
		let anyExplains = false

		for (const [name, detector] of Object.entries(DETECTORS) as Array<
			[DetectorName, (typeof DETECTORS)[DetectorName]]
		>) {
			if (!detector.fires(span.value, row.country)) continue

			tally[name].fired++

			if (detector.reads === span.tag) {
				tally[name].explained++
				anyExplains = true
			} else {
				tally[name].falselyFlagged[span.tag] = (tally[name].falselyFlagged[span.tag] ?? 0) + 1
				falseFlags.push({ id: row.id, input: row.input, detector: name, tag: span.tag, value: span.value })
			}
		}

		if (!anyExplains && (span.tag === "postcode" || span.tag === "house_number" || span.tag === "unit")) {
			missed[span.tag] = (missed[span.tag] ?? 0) + 1
		}
	}
}

console.log(`${cases.length} board rows; ${valuesRead} located expected components hold a digit`)

for (const [name, t] of Object.entries(tally)) {
	console.log(`${name}: fired ${t.fired}, explained ${t.explained}, falsely flagged ${stringify(t.falselyFlagged)}`)
}

console.log(`postcode, house_number and unit values no detector explains: ${stringify(missed)}`)

for (const flag of falseFlags.slice(0, 25)) {
	console.log(`  false ${flag.detector}: ${flag.tag} ${stringifyJSON(flag.value)} in ${stringifyJSON(flag.input)}`)
}

if (values["out-json"]) {
	await writeLocalJSONFile(
		{ rows: cases.length, valuesRead, tally, missed, falseFlags, signatures },
		values["out-json"]
	)
}

function stringify(counts: Record<string, number>): string {
	return (
		Object.entries(counts)
			.map(([key, n]) => `${key} ${n}`)
			.join(", ") || "none"
	)
}
