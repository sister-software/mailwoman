/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The knob arms reader rejects every arms file whose replay would read as a real measurement while
 *   testing nothing: a misspelled option, a function-valued option, a wrong value type, a repeated label.
 */

import { parseKnobArms } from "mailwoman/eval-harness/same-data/knob-arms"
import { describe, expect, it } from "vitest"

describe("parseKnobArms", () => {
	it("reads labels and options in file order", () => {
		const arms = parseKnobArms([
			{ label: "shipped", opts: {} },
			{ label: "cap 150 km", opts: { postcodeConsistencyMaxMoveKm: 150 } },
			{ label: "weak either", opts: { spanRescoreWeakResolution: "either", streetCountryHints: ["US"] } },
		])

		expect(arms.map((arm) => arm.label)).toEqual(["shipped", "cap 150 km", "weak either"])
		expect(arms[1]?.opts).toEqual({ postcodeConsistencyMaxMoveKm: 150 })
	})

	it("rejects an option name that is not a ResolveOpts field", () => {
		expect(() => parseKnobArms([{ label: "typo", opts: { postcodeConsistencyMaxMoveKM: 150 } }])).toThrow(
			/"postcodeConsistencyMaxMoveKM", which is not a ResolveOpts field/
		)
	})

	it("rejects an option JSON cannot express", () => {
		expect(() => parseKnobArms([{ label: "sink", opts: { traceSink: "x" } }])).toThrow(/cannot express/)
	})

	it("rejects a value of the wrong type", () => {
		expect(() => parseKnobArms([{ label: "off", opts: { spanRescore: "false" } }])).toThrow(/expected boolean/)

		expect(() => parseKnobArms([{ label: "weak", opts: { spanRescoreWeakResolution: "loose" } }])).toThrow(
			/expected weak-resolution/
		)
	})

	it("rejects an empty file, a missing opts object and a repeated label", () => {
		expect(() => parseKnobArms([])).toThrow(/non-empty array/)
		expect(() => parseKnobArms([{ label: "bare" }])).toThrow(/no "opts" object/)

		expect(() =>
			parseKnobArms([
				{ label: "a", opts: {} },
				{ label: "a", opts: {} },
			])
		).toThrow(/appears twice/)
	})
})
