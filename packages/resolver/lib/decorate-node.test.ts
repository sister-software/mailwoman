/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `0,0` is the gazetteer's unlocated sentinel. A node must represent that value as absence.
 *
 *   The shipped extracts contain many `0,0` sentinels. They occur in 48,216 of 142,604 JP postcodes,
 *   86,377 GB postcodes, 9,708 international postcodes and 414 US postcodes. A stamped `0,0` passes
 *   every downstream `lat != null` check, including the admin ladder in `extractGeocodeResult`.
 *   ZIP `51349` is the worked case. The extract cannot place this real Iowa ZIP. The null check accepts
 *   the Gulf of Guinea coordinate. That point lies 10,450 km from the ZIP's address.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS, type ResolvedPlace } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { decorateNode, isResolvedWithCoord } from "#decorate-node"

const node = (over: Partial<AddressNode> = {}): AddressNode => ({
	tag: "postcode",
	value: "51349",
	start: 0,
	end: 5,
	confidence: 0.9,
	children: [],
	...over,
})

const place = (over: Partial<ResolvedPlace> = {}): ResolvedPlace => ({
	...EMPTY_PLACE_FIELDS,
	id: 538_966_645,
	name: "51349",
	placetype: "postalcode",
	country: "US",
	lat: 43.32,
	lon: -95.47,
	score: 1,
	exactMatch: true,
	...over,
})

describe("decorateNode and the unlocated sentinel", () => {
	it("stamps a real coordinate", () => {
		const n = node()

		decorateNode(n, place(), [])

		expect(n.lat).toBe(43.32)
		expect(n.lon).toBe(-95.47)
		expect(isResolvedWithCoord(n)).toBe(true)
	})

	it("leaves the coordinate ABSENT for a 0,0 place, and still identifies it", () => {
		const n = node()

		decorateNode(n, place({ lat: 0, lon: 0 }), [])

		expect(n.lat).toBeUndefined()
		expect(n.lon).toBeUndefined()
		// The place is resolved — it simply cannot say where it is.
		// The removed identity would discard the one fact the extract does know.
		expect(n.placeID).toBe("wof:538966645")
		expect(n.metadata?.["resolver_name"]).toBe("51349")
		expect(isResolvedWithCoord(n)).toBe(false)
	})

	it("clears a stale coordinate rather than leaving it beside a new placeID", () => {
		const n = node({ lat: 39.8, lon: -89.64, placeID: "wof:554735275" })

		decorateNode(n, place({ lat: 0, lon: 0 }), [])

		expect(n.lat).toBeUndefined()
		expect(n.lon).toBeUndefined()
		expect(n.placeID).toBe("wof:538966645")
	})

	it("treats a 0 on ONE axis as a real coordinate", () => {
		// The sentinel is the pair.
		// Null Island is one point.
		// The equator and prime meridian each contain real locations.
		// Accra, Greenwich and Libreville sit near one of them.
		for (const coord of [
			{ lat: 0, lon: -0.0005 },
			{ lat: 5.55, lon: 0 },
		]) {
			const n = node()

			decorateNode(n, place(coord), [])

			expect(n.lat).toBe(coord.lat)
			expect(n.lon).toBe(coord.lon)
		}
	})

	it("leaves the coordinate absent for a place that carries none at all", () => {
		const n = node()
		const { lat: _lat, lon: _lon, ...coordinateless } = place()

		decorateNode(n, coordinateless, [])

		expect(n.lat).toBeUndefined()
		expect(n.lon).toBeUndefined()
		expect(n.placeID).toBe("wof:538966645")
	})
})
