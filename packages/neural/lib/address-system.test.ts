/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Interface tests for address-system detection and the conventions mask.
 *   Detection never acts below threshold or off-vocabulary. The mask removes forbidden tags from
 *   the decodable vocabulary. A model without a locale head is a byte-identical no-op.
 */

import { conventionsForSystem } from "@mailwoman/codex"
import { describe, expect, it } from "vitest"

import { detectAddressSystem, LOCALE_COUNTRIES, localeHintID, parseAddressSystemTable } from "#address-system"
import { packLocaleHintFeed } from "#ort-feeds"

/**
 * Logits that put `prob` mass on `idx` (softmax of one-hot × scale).
 */
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
		expect(detectAddressSystem(LOCALE_COUNTRIES.map(() => 1))).toBeNull()
	})

	it("returns null for locales without a codex system (ES/IT/NL)", () => {
		expect(detectAddressSystem(confident(LOCALE_COUNTRIES.indexOf("ES")))).toBeNull()
	})

	it("returns null when the model has no locale head", () => {
		expect(detectAddressSystem(null)).toBeNull()
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
		// FR has a leading street_prefix ("Rue de Rivoli") that the model emits,
		// so the conventions row forbids only the trailing USPS-style street_suffix.
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

describe("locale hint", () => {
	const table = parseAddressSystemTable(
		{ count: 3, no_hint: 3, members: { "RU/local": 0, "HK/local": 1, "HK/latin": 2 } },
		"test card"
	)!

	it("reads the country's latin system for Latin-script text and its local system otherwise", () => {
		expect(localeHintID(table, "hk", "1 Queen's Road Central")).toBe(2)
		expect(localeHintID(table, "HK", "香港中環皇后大道中1號")).toBe(1)
		expect(localeHintID(table, "RU", "Tverskaya 13, Moscow")).toBe(0)
	})

	it("gives no hint for an absent or unknown country", () => {
		expect(localeHintID(table, null, "anything")).toBe(3)
		expect(localeHintID(table, "GH", "Plot 12, Spintex Road")).toBe(3)
	})

	it("reads a card without the field as no table, and refuses a malformed one", () => {
		expect(parseAddressSystemTable(undefined, "card")).toBeNull()
		expect(() => parseAddressSystemTable({ no_hint: "3", members: {} }, "card")).toThrow(/address_systems/u)
	})

	it("feeds the hint only to a graph that declares it, and feeds -1 for a missing id", () => {
		expect(packLocaleHintFeed(["input_ids"], undefined)).toBeNull()
		expect(packLocaleHintFeed(["input_ids", "locale_hint"], 2)).toEqual({ data: BigInt64Array.of(2n), dims: [1] })
		expect(packLocaleHintFeed(["locale_hint"], undefined)).toEqual({ data: BigInt64Array.of(-1n), dims: [1] })
	})
})
