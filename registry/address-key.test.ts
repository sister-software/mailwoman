/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isPostalAddressID } from "@mailwoman/address-id"
import { block } from "@mailwoman/match"
import { describe, expect, it } from "vitest"

import { addressIDBlockingKey, postalAddressID } from "./address-key.js"
import type { SourceRecord } from "./types.js"

function record(id: string, raw: string, lat: number, lon: number, geocoded = true): SourceRecord {
	return {
		id,
		address: {
			components: {},
			canonicalKey: raw.toLowerCase(),
			raw,
			...(geocoded
				? { geocode: { coordinate: { latitude: lat, longitude: lon }, tier: "address_point", uncertaintyMeters: 1 } }
				: {}),
		},
	}
}

describe("postalAddressID", () => {
	it("derives a stable id from a geocoded record", () => {
		const id = postalAddressID(record("1", "100 Congress Ave, Austin, TX 78701", 30.2672, -97.7431))
		expect(id).not.toBeNull()
		expect(isPostalAddressID(id!)).toBe(true)
	})

	it("gives the same id to two records at the same place with the same address", () => {
		const a = postalAddressID(record("1", "100 Congress Ave, Austin, TX 78701", 30.2672, -97.7431))
		const b = postalAddressID(record("2", "100 CONGRESS AVE, austin, tx 78701", 30.2672, -97.7431))
		expect(a).toBe(b)
	})

	it("returns null for an un-geocoded record (no coordinate → no locality cell)", () => {
		expect(postalAddressID(record("3", "100 Congress Ave", 0, 0, false))).toBeNull()
	})
})

describe("addressIDBlockingKey", () => {
	it("blocks records that share an address-id together", () => {
		const a = record("1", "100 Congress Ave, Austin, TX 78701", 30.2672, -97.7431)
		const b = record("2", "100 Congress Ave, Austin, TX 78701", 30.2672, -97.7431)
		const c = record("3", "1 Infinite Loop, Cupertino, CA 95014", 37.3318, -122.0312)
		const { pairs } = block([a, b, c], [addressIDBlockingKey()])
		// a + b share the address-id → one candidate pair; c is alone.
		expect(pairs).toHaveLength(1)
		expect([pairs[0]![0].id, pairs[0]![1].id].sort()).toEqual(["1", "2"])
	})
})
