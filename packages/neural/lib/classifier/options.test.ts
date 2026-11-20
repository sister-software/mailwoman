// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { declaredClassifierConfig, parseAddressSystemConventions } from "#classifier/options"

const SHIPPED_CARD = {
	suppress_gazetteer_near_postcode: true,
	bridge: { required: false },
	conventions: { required: true, mode: "auto" },
}

describe("declaredClassifierConfig", () => {
	it("follows the card's gazetteer suppression and defaults off without one", () => {
		expect(declaredClassifierConfig(SHIPPED_CARD).suppressGazetteerNearPostcode).toBe("on")
		expect(declaredClassifierConfig({}).suppressGazetteerNearPostcode).toBe("off")
		expect(declaredClassifierConfig(null).suppressGazetteerNearPostcode).toBe("off")
	})

	it("lets an explicit gazetteer suppression setting replace the card", () => {
		expect(
			declaredClassifierConfig(SHIPPED_CARD, { suppressGazetteerNearPostcode: "off" }).suppressGazetteerNearPostcode
		).toBe("off")

		expect(declaredClassifierConfig(null, { suppressGazetteerNearPostcode: "on" }).suppressGazetteerNearPostcode).toBe(
			"on"
		)
	})

	it("follows the card's bridge declaration and defaults off without one", () => {
		expect(declaredClassifierConfig(SHIPPED_CARD).bridgePunctuationGaps).toBe("off")
		expect(declaredClassifierConfig({ bridge: { required: true } }).bridgePunctuationGaps).toBe("on")
		expect(declaredClassifierConfig(null).bridgePunctuationGaps).toBe("off")
	})

	it("lets an explicit bridge setting replace the card", () => {
		expect(declaredClassifierConfig(SHIPPED_CARD, { bridgePunctuationGaps: "on" }).bridgePunctuationGaps).toBe("on")

		expect(
			declaredClassifierConfig({ bridge: { required: true } }, { bridgePunctuationGaps: "off" }).bridgePunctuationGaps
		).toBe("off")
	})

	it("takes the card's conventions mode when the card requires conventions", () => {
		expect(declaredClassifierConfig(SHIPPED_CARD).addressSystemConventions).toBe("auto")

		expect(declaredClassifierConfig({ conventions: { required: true, mode: "gb" } }).addressSystemConventions).toBe(
			"gb"
		)

		expect(declaredClassifierConfig({ conventions: { required: true } }).addressSystemConventions).toBe("auto")
	})

	it("leaves conventions off when the card does not require them", () => {
		expect(declaredClassifierConfig({ conventions: { required: false, mode: "gb" } }).addressSystemConventions).toBe(
			"off"
		)

		expect(declaredClassifierConfig(null).addressSystemConventions).toBe("off")
	})

	it("lets an explicit conventions mode replace the card", () => {
		expect(declaredClassifierConfig(SHIPPED_CARD, { addressSystemConventions: "off" }).addressSystemConventions).toBe(
			"off"
		)

		expect(declaredClassifierConfig(null, { addressSystemConventions: "us" }).addressSystemConventions).toBe("us")
	})

	it("refuses a card conventions mode that is not a conventions mode", () => {
		expect(() => declaredClassifierConfig({ conventions: { required: true, mode: "zz" } })).toThrow(
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
