/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	addressSystemConventionsFor,
	gazetteerSuppressionFor,
	parseAddressSystemConventions,
	punctuationBridgingFor,
} from "#classifier/options"

const SHIPPED_CARD = {
	suppress_gazetteer_near_postcode: true,
	bridge: { required: false },
	conventions: { required: true, mode: "auto" },
}

describe("gazetteerSuppressionFor", () => {
	it("follows the card's declaration and defaults off without one", () => {
		expect(gazetteerSuppressionFor("declared", SHIPPED_CARD)).toBe("on")
		expect(gazetteerSuppressionFor("declared", {})).toBe("off")
		expect(gazetteerSuppressionFor("declared", null)).toBe("off")
	})

	it("lets an explicit setting replace the card", () => {
		expect(gazetteerSuppressionFor("off", SHIPPED_CARD)).toBe("off")
		expect(gazetteerSuppressionFor("on", null)).toBe("on")
	})
})

describe("punctuationBridgingFor", () => {
	it("follows the card's bridge declaration and defaults off without one", () => {
		expect(punctuationBridgingFor("declared", SHIPPED_CARD)).toBe("off")
		expect(punctuationBridgingFor("declared", { bridge: { required: true } })).toBe("on")
		expect(punctuationBridgingFor("declared", null)).toBe("off")
	})

	it("lets an explicit setting replace the card", () => {
		expect(punctuationBridgingFor("on", SHIPPED_CARD)).toBe("on")
		expect(punctuationBridgingFor("off", { bridge: { required: true } })).toBe("off")
	})
})

describe("addressSystemConventionsFor", () => {
	it("takes the card's mode when the card requires conventions", () => {
		expect(addressSystemConventionsFor("declared", SHIPPED_CARD)).toBe("auto")
		expect(addressSystemConventionsFor("declared", { conventions: { required: true, mode: "gb" } })).toBe("gb")
		expect(addressSystemConventionsFor("declared", { conventions: { required: true } })).toBe("auto")
	})

	it("is off when the card does not require conventions", () => {
		expect(addressSystemConventionsFor("declared", { conventions: { required: false, mode: "gb" } })).toBe("off")
		expect(addressSystemConventionsFor("declared", null)).toBe("off")
	})

	it("lets an explicit mode replace the card", () => {
		expect(addressSystemConventionsFor("off", SHIPPED_CARD)).toBe("off")
		expect(addressSystemConventionsFor("us", null)).toBe("us")
	})

	it("refuses a card mode that is not a conventions mode", () => {
		expect(() => addressSystemConventionsFor("declared", { conventions: { required: true, mode: "zz" } })).toThrow(
			/unknown address-system conventions mode "zz"/
		)
	})
})

describe("parseAddressSystemConventions", () => {
	it("accepts off, auto and the system codes", () => {
		expect(parseAddressSystemConventions("off")).toBe("off")
		expect(parseAddressSystemConventions("auto")).toBe("auto")
		expect(parseAddressSystemConventions("jp")).toBe("jp")
	})

	it("refuses anything else", () => {
		expect(() => parseAddressSystemConventions("AUTO")).toThrow(/unknown address-system conventions mode/)
	})
})
