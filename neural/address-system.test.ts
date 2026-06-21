/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Contract tests for address-system detection + the conventions mask (#511 Tier A). The essential
 *   properties: detection never acts below threshold or off-vocabulary, the mask removes forbidden
 *   tags from the decodable vocabulary, and models without a locale head are byte-identical
 *   no-ops.
 */

import { describe, expect, it } from "vitest"

import { conventionsForSystem } from "@mailwoman/codex"
import { detectAddressSystem, LOCALE_COUNTRIES } from "./address-system.js"

/** Logits that put `prob` mass on `idx` (softmax of one-hot × scale). */
function confident(idx: number, scale = 10): number[] {
	return LOCALE_COUNTRIES.map((_, i) => (i === idx ? scale : 0))
}

describe("detectAddressSystem", () => {
	it("detects a confident locale and maps it to a system", () => {
		const fr = detectAddressSystem(confident(LOCALE_COUNTRIES.indexOf("FR")))
		expect(fr).toMatchObject({ system: "fr", country: "FR" })
		expect(fr!.confidence).toBeGreaterThan(0.99)
	})

	it("returns null below the confidence threshold", () => {
		// Uniform logits → 1/9 ≈ 0.11 confidence.
		expect(detectAddressSystem(LOCALE_COUNTRIES.map(() => 1))).toBeNull()
	})

	it("returns null for locales without a codex system (ES/IT/NL)", () => {
		expect(detectAddressSystem(confident(LOCALE_COUNTRIES.indexOf("ES")))).toBeNull()
	})

	it("returns null when the model has no locale head", () => {
		expect(detectAddressSystem(undefined)).toBeNull()
	})

	it("returns null on a vocabulary-size mismatch (drifted head)", () => {
		expect(detectAddressSystem([5, 0, 0])).toBeNull()
	})

	it("respects a custom threshold", () => {
		const logits = confident(LOCALE_COUNTRIES.indexOf("FR"), 1.5)
		expect(detectAddressSystem(logits, 0.99)).toBeNull()
		expect(detectAddressSystem(logits, 0.3)).not.toBeNull()
	})
})

describe("conventions table", () => {
	it("fr forbids only the trailing street_suffix (NOT street_prefix) and pins the 5-digit shape", () => {
		// Post-#719: FR has a LEADING street_prefix ("Rue de Rivoli") that the model emits, so
		// the conventions row forbids only the trailing USPS-style street_suffix — forbidding the prefix
		// destroyed real capability (see address-system-conventions.ts provenance + the load-time gate).
		const fr = conventionsForSystem("fr")!
		expect(fr.forbiddenTags).toEqual(["street_suffix"])
		expect(fr.forbiddenTags).not.toContain("street_prefix")
		expect(fr.postcodePattern!.test("47110")).toBe(true)
		expect(fr.postcodePattern!.test("4711")).toBe(false)
	})

	it("absent rows mean no constraints, never defaults", () => {
		expect(conventionsForSystem("us")).toBeNull()
		expect(conventionsForSystem(null)).toBeNull()
	})
})
