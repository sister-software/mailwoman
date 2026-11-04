import { describe, expect, it } from "vitest"

import { compactPostcode, normalizePostcodeDisplay } from "#display-form"

describe("normalizePostcodeDisplay", () => {
	it("collapses whitespace runs to one space, trims and upper-cases", () => {
		expect(normalizePostcodeDisplay(" bt3  9qq ")).toBe("BT3 9QQ")
	})
})

describe("compactPostcode", () => {
	it("removes every whitespace character and upper-cases, Code-Point Open's spr.name form", () => {
		expect(compactPostcode("RG40 4HR")).toBe("RG404HR")
		expect(compactPostcode("po21 1hr")).toBe("PO211HR")
		expect(compactPostcode("RG404HR")).toBe("RG404HR")
		expect(compactPostcode(" LL55  1BZ ")).toBe("LL551BZ")
	})
})
