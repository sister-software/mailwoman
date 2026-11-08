/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { isAdmittedLicense, isAdmittedSource } from "#address-records/admission"

describe("isAdmittedLicense", () => {
	it.each([
		[null],
		[{ text: "Public Domain", attribution: false, "share-alike": false }],
		[{ text: "CC BY 3.0", url: "https://creativecommons.org/licenses/by/3.0/" }],
		[{ url: "https://creativecommons.org/publicdomain/zero/1.0/", text: "CC 0" }],
		[{ attribution: true, "attribution name": "Benzie County", presumed: true }],
	])("admits %j", (license) => {
		expect(isAdmittedLicense(license)).toBe(true)
	})

	it.each([
		[{ text: "CC-BY-SA", "share-alike": true }],
		[{ text: "CC-BY-SA" }],
		[{ text: "CC BY SA 4.0" }],
		[{ text: "CC BY-NC 4.0" }],
		[{ text: "CC BY-ND 4.0" }],
		["CC BY-NC-SA 4.0"],
		[{ text: "Creative Commons Attribution-NonCommercial 4.0" }],
		[{ text: "Not for commercial use or resale." }],
		[{ text: "Indemnification", attribution: false, "share-alike": false }],
		[{ url: "https://www.opendataphilly.org/organization/about/city-of-philadelphia" }],
		["https://www.acgov.org/acdata/terms.htm"],
		["Unknown"],
	])("refuses %j", (license) => {
		expect(isAdmittedLicense(license)).toBe(false)
	})
})

describe("isAdmittedSource", () => {
	it("admits a reviewed source its recorded wording alone would refuse", () => {
		expect(isAdmittedSource("us/tx/san_antonio", { text: "Indemnification" })).toBe(true)
		expect(isAdmittedSource("us/pa/bucks", { text: "Not for commercial use or resale." })).toBe(false)
	})
})
