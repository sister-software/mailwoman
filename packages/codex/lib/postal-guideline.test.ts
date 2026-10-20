import { describe, expect, it } from "vitest"

import { AU_DELIVERY_GUIDELINE_RULES, AU_LOCALITY_LINE_RULE } from "#au/delivery-guideline"
import { DE_POSTFACH_RULES } from "#de/postfach"
import { IT_CASELLA_POSTALE_RULES } from "#it/casella-postale"
import { assertPostalGuidelineCitation, type PoBoxGuidelineRule } from "#postal-guideline"

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

describe("assertPostalGuidelineCitation", () => {
	const citation = DE_POSTFACH_RULES[0].citation

	it("refuses a citation with an empty quote", () => {
		expect(() => assertPostalGuidelineCitation({ ...citation, quote: " " }, "x")).toThrow(/no quote/u)
	})

	it("refuses a hash that is not 64 lower-case hex digits", () => {
		expect(() => assertPostalGuidelineCitation({ ...citation, sha256: "9de9f916" }, "x")).toThrow(/sha256/u)
	})
})
