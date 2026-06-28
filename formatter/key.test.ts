/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { canonicalKey, normalizeAddressToken } from "./key.js"

describe("normalizeAddressToken", () => {
	it("lowercases and collapses whitespace", () => {
		expect(normalizeAddressToken("  Main   STREET ")).toBe("main street")
	})

	it("strips diacritics via NFKD decomposition", () => {
		expect(normalizeAddressToken("Béziers")).toBe("beziers")
		expect(normalizeAddressToken("Cañon")).toBe("canon")
	})

	it("turns connective punctuation into spaces rather than deleting it", () => {
		expect(normalizeAddressToken("A & B")).toBe("a b")
		expect(normalizeAddressToken("King+Queen")).toBe("king queen")
	})

	it("drops other punctuation", () => {
		expect(normalizeAddressToken("St. Paul's, #4")).toBe("st pauls 4")
	})

	it("returns empty for punctuation-only input", () => {
		expect(normalizeAddressToken("—.,!")).toBe("")
	})
})

describe("canonicalKey", () => {
	it("emits identifying fields in canonical order, separated by |", () => {
		const key = canonicalKey({
			house_number: "123",
			street: "Main",
			street_suffix: "St",
			locality: "Portland",
			region: "OR",
			postcode: "97201",
			country: "US",
		})

		expect(key).toBe("123|main|st|portland|or|97201|us")
	})

	it("is invariant to case, punctuation, and spelling noise", () => {
		const a = canonicalKey({ house_number: "123", street: "Main St.", locality: "St. Paul", region: "MN" })
		const b = canonicalKey({ house_number: "123", street: "main  st", locality: "St Paul", region: "mn" })

		expect(a).toBe(b)
	})

	it("excludes venue / attention (organization identity, not address)", () => {
		const key = canonicalKey({ venue: "Acme Clinic", attention: "Front Desk", locality: "Reno" })

		expect(key).toBe("reno")
	})

	it("skips empty and whitespace-only fields", () => {
		const key = canonicalKey({ house_number: "12", street: "   ", locality: "Boise" })

		expect(key).toBe("12|boise")
	})

	it("returns empty string when nothing identifying is present", () => {
		expect(canonicalKey({})).toBe("")
		expect(canonicalKey({ venue: "Acme" })).toBe("")
	})

	it("honors a custom separator", () => {
		const key = canonicalKey({ house_number: "9", street: "Elm", locality: "Ames" }, { separator: " " })

		expect(key).toBe("9 elm ames")
	})
})
