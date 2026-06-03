/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { DE_BUNDESLAENDER, isGermanStateCode, lookupGermanState } from "./bundesland.js"

describe("DE_BUNDESLAENDER", () => {
	it("covers all 16 Bundesländer", () => {
		expect(Object.keys(DE_BUNDESLAENDER)).toHaveLength(16)
		expect(DE_BUNDESLAENDER.BY).toEqual({ code: "BY", name: "Bayern", english: "Bavaria" })
	})
})

describe("isGermanStateCode", () => {
	it("accepts ISO 3166-2:DE codes, case-insensitively", () => {
		expect(isGermanStateCode("BY")).toBe(true)
		expect(isGermanStateCode("nw")).toBe(true)
		expect(isGermanStateCode("CA")).toBe(false) // a US state, not German
	})
})

describe("lookupGermanState", () => {
	it("resolves code, German name, English exonym, and common alias to the ISO code", () => {
		expect(lookupGermanState("BY")).toBe("BY")
		expect(lookupGermanState("Bayern")).toBe("BY")
		expect(lookupGermanState("Bavaria")).toBe("BY")
		expect(lookupGermanState("Saxony")).toBe("SN")
		expect(lookupGermanState("NRW")).toBe("NW")
		expect(lookupGermanState("Nordrhein-Westfalen")).toBe("NW")
	})

	it("returns null for an unknown region", () => {
		expect(lookupGermanState("California")).toBeNull()
		expect(lookupGermanState(null)).toBeNull()
	})
})
