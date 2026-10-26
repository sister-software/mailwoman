import { describe, expect, it } from "vitest"

import { codeUnitPattern, segmentCodeUnits } from "#code-units"

describe("segmentCodeUnits", () => {
	it("keeps each digit run and alphanumeric code whole", () => {
		const text = "350 5th Ave, New York, NY 10118-0110, SW1A 1AA"

		expect(segmentCodeUnits(text).map((unit) => unit.text)).toEqual(["350", "5th", "10118-0110", "SW1A", "1AA"])
	})

	it("records offsets that slice the unit back out of the text", () => {
		const text = "〒100-0005 東京都千代田区丸の内1-9-1"

		for (const unit of segmentCodeUnits(text)) {
			expect(text.slice(unit.start, unit.end)).toBe(unit.text)
		}

		expect(segmentCodeUnits(text).map((unit) => unit.text)).toEqual(["100-0005", "1-9-1"])
	})

	it("leaves a word without a digit and a hyphen before a letter alone", () => {
		expect(segmentCodeUnits("Main Street Unit-B")).toEqual([])
		expect(segmentCodeUnits("12-B").map((unit) => unit.text)).toEqual(["12"])
	})
})

describe("codeUnitPattern", () => {
	it("writes 9 per digit and A per letter", () => {
		expect(codeUnitPattern("SW1A")).toBe("AA9A")
		expect(codeUnitPattern("10118-0110")).toBe("99999-9999")
	})
})
