/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { openAddressesRow, postcodeNearPoint, repeatsStoredPoint } from "./openaddresses.ts"

describe("postcodeNearPoint", () => {
	const dueWest = { postcode: "29639", geometry: "[[-82.38815,34.328206],[-82.3896,34.32932]]" }
	const beaufort = { postcode: "29945", geometry: "[[-80.861,32.6937],[-80.862,32.6945]]" }

	it("takes the postcode of the segment beside the point", () => {
		expect(postcodeNearPoint({ lat: 32.6936489, lon: -80.8609899 }, [dueWest, beaufort])).toBe("29945")
	})

	it("reads null when the only segment of that name and number lies elsewhere", () => {
		expect(postcodeNearPoint({ lat: 32.6936489, lon: -80.8609899 }, [dueWest])).toBeNull()
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
