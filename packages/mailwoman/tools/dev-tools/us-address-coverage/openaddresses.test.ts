/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { isAdmittedLicense, openAddressesRow, repeatsStoredPoint } from "./openaddresses.ts"

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
		[{ text: "Not for commercial use or resale." }],
		[{ text: "Indemnification", attribution: false, "share-alike": false }],
		[{ url: "https://www.opendataphilly.org/organization/about/city-of-philadelphia" }],
		["https://www.acgov.org/acdata/terms.htm"],
		["Unknown"],
	])("refuses %j", (license) => {
		expect(isAdmittedLicense(license)).toBe(false)
	})
})

describe("openAddressesRow", () => {
	const record = {
		lat: "43.68",
		lon: "-88.16",
		number: "N3971",
		street: "SUNNY SLOPE AVE",
		city: "Cascade",
		postcode: "53011-1234",
	}

	it("reads a record with the lookup's keys, keeping a grid number's letter", () => {
		expect(openAddressesRow(record, "us/wi/statewide", "2026-11-06")).toMatchObject({
			number: "n3971",
			postcode: "53011",
			locality_norm: "cascade",
			source: "openaddresses:us/wi/statewide",
		})
	})

	it("refuses a record with no coordinate or number", () => {
		expect(openAddressesRow({ ...record, lat: "" }, "m", "r")).toBeNull()
		expect(openAddressesRow({ ...record, number: " " }, "m", "r")).toBeNull()
	})
})

describe("repeatsStoredPoint", () => {
	it("reads a nearby point as the same address and a far one as another", () => {
		const row = { lat: 40, lon: -75 }

		expect(repeatsStoredPoint(row, [{ lat: 40.001, lon: -75.001 }])).toBe(true)
		expect(repeatsStoredPoint(row, [{ lat: 41, lon: -75 }])).toBe(false)
	})
})
