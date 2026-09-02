/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1684 check pins. The absent-verdict and explicit-scope cases ARE the contract: unknown is not foreign, and an
 *   explicit caller scope is never second-guessed here.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { shouldDropInferredScope } from "mailwoman/inferred-scope"
import { describe, expect, it } from "vitest"

function tree(localeCountry?: { country: string; confidence: number }): AddressTree {
	return { raw: "x", roots: [], ...(localeCountry ? { localeCountry } : {}) }
}

describe("shouldDropInferredScope (#1684)", () => {
	it("drops an inferred scope on a confident CONTRARY read — the Nanjing/Chat-qui-Pêche class", () => {
		expect(shouldDropInferredScope(tree({ country: "GB", confidence: 1 }), "US", true)).toBe(true)
		expect(shouldDropInferredScope(tree({ country: "FR", confidence: 0.99 }), "US", true)).toBe(true)
	})

	it("keeps the scope when the head AGREES — the 75008 protection", () => {
		expect(shouldDropInferredScope(tree({ country: "US", confidence: 1 }), "US", true)).toBe(false)
		expect(shouldDropInferredScope(tree({ country: "us", confidence: 1 }), "US", true)).toBe(false)
	})

	it("keeps the scope on an ABSENT verdict — unknown is not foreign (the Sacremento protection)", () => {
		expect(shouldDropInferredScope(tree(), "US", true)).toBe(false)
	})

	it("never touches an EXPLICIT scope, whatever the head says", () => {
		expect(shouldDropInferredScope(tree({ country: "FR", confidence: 1 }), "US", false)).toBe(false)
	})

	it("drops on a postcode FORMAT that excludes the inferred country — the A1V 0A9 Gander class", () => {
		expect(shouldDropInferredScope(tree(), "US", true, ["CA"])).toBe(true)
	})

	it("keeps the scope when the format set INCLUDES the inferred country — the 75008 protection again", () => {
		expect(shouldDropInferredScope(tree(), "US", true, ["US", "FR", "DE"])).toBe(false)
	})

	it("an empty format set is silence, not foreignness", () => {
		expect(shouldDropInferredScope(tree(), "US", true, [])).toBe(false)
	})

	it("the format signal never overrides an EXPLICIT scope either", () => {
		expect(shouldDropInferredScope(tree(), "US", false, ["CA"])).toBe(false)
	})
})
