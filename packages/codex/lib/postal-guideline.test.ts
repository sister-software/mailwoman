import { describe, expect, it } from "vitest"

import { AU_DELIVERY_GUIDELINE_RULES, AU_LOCALITY_LINE_RULE } from "#au/delivery-guideline"
import { AU_UNIT_PLACEMENT_RULES, AU_UNIT_TYPE_RULES } from "#au/unit-type"
import { DE_POSTFACH_RULES } from "#de/postfach"
import { FR_UNIT_LINE_RULES, FR_UNIT_PLACEMENT_RULES } from "#fr/unit-line"
import { GB_SUB_BUILDING_PLACEMENT_RULES, GB_SUB_BUILDING_RULES } from "#gb/sub-building"
import { IT_CASELLA_POSTALE_RULES } from "#it/casella-postale"
import { IT_UNIT_LINE_RULES } from "#it/unit-line"
import { NZ_UNIT_PLACEMENT_RULES, NZ_UNIT_TYPE_RULES } from "#nz/unit-type"
import { assertPostalGuidelineCitation, type PoBoxGuidelineRule, type PostalGuidelineRule } from "#postal-guideline"
import { US_UNIT_DESIGNATOR_PREFERRED_ABBR } from "#us/unit-designator"
import { US_UNIT_GUIDELINE_RULES, US_UNIT_PLACEMENT_RULES } from "#us/unit-guideline"

const TABLES: Record<string, readonly PoBoxGuidelineRule[]> = {
	AU: AU_DELIVERY_GUIDELINE_RULES,
	DE: DE_POSTFACH_RULES,
	IT: IT_CASELLA_POSTALE_RULES,
}

describe("PoBoxGuidelineRule tables", () => {
	for (const [country, rules] of Object.entries(TABLES)) {
		it(`${country}: every rule carries a complete citation and a unique id`, () => {
			expect(rules.length).toBeGreaterThan(0)

			for (const rule of rules) {
				expect(() => assertPostalGuidelineCitation(rule.citation, rule.id)).not.toThrow()
			}

			expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length)
		})
	}

	it("AU: the locality-line rule carries a complete citation", () => {
		expect(() => assertPostalGuidelineCitation(AU_LOCALITY_LINE_RULE.citation, "au-locality-line")).not.toThrow()
	})

	it("AU: reads whether a type takes a number from the delivery-service table", () => {
		const byDesignator = Object.fromEntries(AU_DELIVERY_GUIDELINE_RULES.map((rule) => [rule.designator, rule]))

		expect(byDesignator["CARE PO"]!.requiresNumber).toBe(false)
		expect(byDesignator["MS"]!.requiresNumber).toBe(true)
		expect(byDesignator["RMS"]!.requiresNumber).toBe(true)
	})
})

const UNIT_TABLES: Record<string, readonly PostalGuidelineRule[]> = {
	AU: [...AU_UNIT_TYPE_RULES, ...AU_UNIT_PLACEMENT_RULES],
	FR: [...FR_UNIT_LINE_RULES, ...FR_UNIT_PLACEMENT_RULES],
	GB: [...GB_SUB_BUILDING_RULES, ...GB_SUB_BUILDING_PLACEMENT_RULES],
	IT: IT_UNIT_LINE_RULES,
	NZ: [...NZ_UNIT_TYPE_RULES, ...NZ_UNIT_PLACEMENT_RULES],
	US: [...US_UNIT_GUIDELINE_RULES, ...US_UNIT_PLACEMENT_RULES],
}

describe("PostalUnitGuidelineRule tables", () => {
	for (const [country, rules] of Object.entries(UNIT_TABLES)) {
		it(`${country}: every rule carries a complete citation and a unique id`, () => {
			expect(rules.length).toBeGreaterThan(0)

			for (const rule of rules) {
				expect(() => assertPostalGuidelineCitation(rule.citation, rule.id)).not.toThrow()
			}

			expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length)
		})
	}

	it("US: cites every Appendix C2 designator the codex table holds, with its approved abbreviation", () => {
		expect(US_UNIT_GUIDELINE_RULES.map((rule) => rule.designator)).toEqual(
			Object.keys(US_UNIT_DESIGNATOR_PREFERRED_ABBR)
		)

		for (const rule of US_UNIT_GUIDELINE_RULES) {
			expect(rule.citation.quote.endsWith(` ${rule.abbreviation}`)).toBe(true)
		}
	})
})

describe("assertPostalGuidelineCitation", () => {
	const citation = DE_POSTFACH_RULES[0].citation

	it("refuses a citation with an empty quote", () => {
		expect(() => assertPostalGuidelineCitation({ ...citation, quote: " " }, "x")).toThrow(/no quote/u)
	})

	it("refuses a hash that is not 64 lower-case hex digits", () => {
		expect(() => assertPostalGuidelineCitation({ ...citation, sha256: "9de9f916" }, "x")).toThrow(/sha256/u)
	})
})
