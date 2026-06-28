/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	AU_LEVEL_DESIGNATORS,
	AU_LEVEL_DESIGNATOR_LOOKUP,
	AU_LEVEL_DESIGNATOR_VARIANTS,
	isAuLevelDesignator,
	matchAuLevelDesignator,
	normalizeAuLevelDesignator,
} from "./level-designator.js"

describe("AU_LEVEL_DESIGNATORS", () => {
	it("carries the nine AS 4590.1-2017 level-type codes", () => {
		const codes = AU_LEVEL_DESIGNATORS.map((r) => r.code).sort()
		expect(codes).toEqual(["B", "G", "L", "LG", "M", "OD", "P", "RT", "UG"].sort())
	})

	it("marks requires-number entries correctly — L, B, P take identifiers; others stand alone", () => {
		const numbered = AU_LEVEL_DESIGNATORS.filter((r) => r.requiresNumber)
			.map((r) => r.code)
			.sort()
		expect(numbered).toEqual(["B", "L", "P"].sort())
		const standalone = AU_LEVEL_DESIGNATORS.filter((r) => !r.requiresNumber)
			.map((r) => r.code)
			.sort()
		expect(standalone).toEqual(["G", "LG", "M", "OD", "RT", "UG"].sort())
	})

	it("every row has a non-empty code, name, and abbreviation — builder must throw on malformed", () => {
		for (const row of AU_LEVEL_DESIGNATORS) {
			expect(row.code.length).toBeGreaterThan(0)
			expect(row.name.length).toBeGreaterThan(0)
			expect(row.abbreviation.length).toBeGreaterThan(0)
		}
	})
})

describe("AU_LEVEL_DESIGNATOR_LOOKUP", () => {
	it("maps canonical, abbreviated, and variant surfaces to the AMAS code", () => {
		expect(AU_LEVEL_DESIGNATOR_LOOKUP.get("level")).toBe("L")
		expect(AU_LEVEL_DESIGNATOR_LOOKUP.get("l")).toBe("L")
		expect(AU_LEVEL_DESIGNATOR_LOOKUP.get("lvl")).toBe("L")
		expect(AU_LEVEL_DESIGNATOR_LOOKUP.get("ground")).toBe("G")
		expect(AU_LEVEL_DESIGNATOR_LOOKUP.get("g")).toBe("G")
		expect(AU_LEVEL_DESIGNATOR_LOOKUP.get("basement")).toBe("B")
		expect(AU_LEVEL_DESIGNATOR_LOOKUP.get("bsmt")).toBe("B")
		expect(AU_LEVEL_DESIGNATOR_LOOKUP.get("mezzanine")).toBe("M")
		expect(AU_LEVEL_DESIGNATOR_LOOKUP.get("m")).toBe("M")
	})

	it("multi-word variants also resolve", () => {
		expect(AU_LEVEL_DESIGNATOR_LOOKUP.get("lower ground")).toBe("LG")
		expect(AU_LEVEL_DESIGNATOR_LOOKUP.get("upper ground")).toBe("UG")
		expect(AU_LEVEL_DESIGNATOR_LOOKUP.get("ground floor")).toBe("G")
	})

	it("all variant keys are present in the lookup", () => {
		for (const [code, variants] of Object.entries(AU_LEVEL_DESIGNATOR_VARIANTS)) {
			for (const v of variants) {
				expect(AU_LEVEL_DESIGNATOR_LOOKUP.get(v.toLowerCase()), `variant "${v}" for code ${code}`).toBeDefined()
			}
		}
	})
})

describe("matchAuLevelDesignator", () => {
	it("matches numbered levels with the AMAS format", () => {
		expect(matchAuLevelDesignator("Level 3")).toMatchObject({ code: "L", identifier: "3" })
		expect(matchAuLevelDesignator("L 12")).toMatchObject({ code: "L", identifier: "12" })
		expect(matchAuLevelDesignator("LVL 5")).toMatchObject({ code: "L", identifier: "5" })
		expect(matchAuLevelDesignator("B 2")).toMatchObject({ code: "B", identifier: "2" })
		expect(matchAuLevelDesignator("Basement 1")).toMatchObject({ code: "B", identifier: "1" })
	})

	it("matches standalone (no-number) level types", () => {
		expect(matchAuLevelDesignator("Ground")).toMatchObject({ code: "G" })
		expect(matchAuLevelDesignator("G")).toMatchObject({ code: "G" })
		expect(matchAuLevelDesignator("Mezzanine")).toMatchObject({ code: "M" })
		expect(matchAuLevelDesignator("Lower Ground")).toMatchObject({ code: "LG" })
		expect(matchAuLevelDesignator("Upper Ground")).toMatchObject({ code: "UG" })
		expect(matchAuLevelDesignator("Rooftop")).toMatchObject({ code: "RT" })
	})

	it("matches multi-word variants", () => {
		expect(matchAuLevelDesignator("Ground Floor")).toMatchObject({ code: "G" })
		expect(matchAuLevelDesignator("Lower Ground Floor")).toMatchObject({ code: "LG" })
	})

	it("rejects a requires-number designator without an identifier", () => {
		expect(matchAuLevelDesignator("Level")).toBeNull()
		expect(matchAuLevelDesignator("L")).toBeNull()
		expect(matchAuLevelDesignator("Basement")).toBeNull()
		expect(isAuLevelDesignator("Level")).toBe(false)
	})

	it("rejects non-level strings", () => {
		expect(matchAuLevelDesignator("Suite 200")).toBeNull()
		expect(matchAuLevelDesignator("PO Box 12")).toBeNull()
		expect(matchAuLevelDesignator("SYDNEY NSW 2000")).toBeNull()
		expect(matchAuLevelDesignator(42)).toBeNull()
	})

	it("is case-insensitive", () => {
		expect(matchAuLevelDesignator("level 3")).toMatchObject({ code: "L", identifier: "3" })
		expect(matchAuLevelDesignator("LEVEL 3")).toMatchObject({ code: "L", identifier: "3" })
		expect(matchAuLevelDesignator("ground floor")).toMatchObject({ code: "G" })
	})
})

describe("normalizeAuLevelDesignator", () => {
	it("canonicalizes to the AMAS abbreviation form", () => {
		expect(normalizeAuLevelDesignator("Level 3")).toBe("L 3")
		expect(normalizeAuLevelDesignator("level 3")).toBe("L 3")
		expect(normalizeAuLevelDesignator("LVL 5")).toBe("L 5")
		expect(normalizeAuLevelDesignator("Ground Floor")).toBe("G")
		expect(normalizeAuLevelDesignator("ground")).toBe("G")
		expect(normalizeAuLevelDesignator("Mezzanine")).toBe("M")
		expect(normalizeAuLevelDesignator("Lower Ground")).toBe("LG")
		expect(normalizeAuLevelDesignator("B 2")).toBe("B 2")
		expect(normalizeAuLevelDesignator("Basement 1")).toBe("B 1")
	})

	it("round-trips: every normalized form still matches", () => {
		const samples = ["L 3", "G", "B 2", "M", "LG", "UG", "P 1", "RT"]

		for (const raw of samples) {
			expect(isAuLevelDesignator(normalizeAuLevelDesignator(raw)), `round-trip for "${raw}"`).toBe(true)
		}
	})

	it("passes through non-level strings unchanged", () => {
		expect(normalizeAuLevelDesignator("Suite 200")).toBe("Suite 200")
		expect(normalizeAuLevelDesignator("PO Box 12")).toBe("PO Box 12")
	})
})
