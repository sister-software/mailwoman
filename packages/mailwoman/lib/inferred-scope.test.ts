/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The absent-verdict and explicit-scope cases are the interface. An absent verdict stays unknown.
 *   and an explicit caller scope is never second-guessed here.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import { shouldDropInferredScope } from "#inferred-scope"

function tree(localeCountry?: { country: string; confidence: number }): AddressTree {
	return { raw: "x", roots: [], ...(localeCountry ? { localeCountry } : {}) }
}

const INFERRED_US = { country: "US", source: "inferred" } as const
const CALLER_US = { country: "US", source: "caller" } as const

describe("shouldDropInferredScope (#1684)", () => {
	it("drops an inferred scope on a confident CONTRARY read — the Nanjing/Chat-qui-Pêche class", () => {
		expect(shouldDropInferredScope(tree({ country: "GB", confidence: 1 }), INFERRED_US)).toBe(true)
		expect(shouldDropInferredScope(tree({ country: "FR", confidence: 0.99 }), INFERRED_US)).toBe(true)
	})

	it("keeps the scope when the head AGREES — the 75008 protection", () => {
		expect(shouldDropInferredScope(tree({ country: "US", confidence: 1 }), INFERRED_US)).toBe(false)
		expect(shouldDropInferredScope(tree({ country: "us", confidence: 1 }), INFERRED_US)).toBe(false)
	})

	it("keeps the scope on an ABSENT verdict — unknown is not foreign (the Sacremento protection)", () => {
		expect(shouldDropInferredScope(tree(), INFERRED_US)).toBe(false)
	})

	it("never touches an EXPLICIT scope, whatever the head says", () => {
		expect(shouldDropInferredScope(tree({ country: "FR", confidence: 1 }), CALLER_US)).toBe(false)
	})

	it("drops on a postcode FORMAT that excludes the inferred country — the A1V 0A9 Gander class", () => {
		expect(shouldDropInferredScope(tree(), INFERRED_US, ["CA"])).toBe(true)
	})

	it("keeps the scope when the format set INCLUDES the inferred country — the 75008 protection again", () => {
		expect(shouldDropInferredScope(tree(), INFERRED_US, ["US", "FR", "DE"])).toBe(false)
	})

	it("an empty format set is silence, not foreignness", () => {
		expect(shouldDropInferredScope(tree(), INFERRED_US, [])).toBe(false)
	})

	it("the format signal never overrides an EXPLICIT scope either", () => {
		expect(shouldDropInferredScope(tree(), CALLER_US, ["CA"])).toBe(false)
	})
})
