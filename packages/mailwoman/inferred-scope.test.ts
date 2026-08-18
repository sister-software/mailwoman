/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1684 gate pins. The absent-verdict and explicit-scope cases ARE the contract: unknown is not foreign, and an
 *   explicit caller scope is never second-guessed here.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import { shouldDropInferredScope } from "./inferred-scope.ts"

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
})
