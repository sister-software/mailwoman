/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `0,0` is the gazetteer's unlocated sentinel. A node must represent that value as absence.
 *
 *   The shipped extracts contain `0,0` sentinels. They occur in 48,216 of 142,604 JP postcodes,
 *   86,377 GB postcodes, 9,708 international postcodes and 414 US postcodes. A stamped `0,0` passes
 *   every downstream `lat != null` check, including the admin ladder in `extractGeocodeResult`.
 *   ZIP `51349` is the worked case. The extract cannot place this real Iowa ZIP. The `lat != null` check accepts
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
		// The place is resolved, and it has no coordinate.
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

describe("decorateNode and the stored extent", () => {
	it("records an extent with area", () => {
		const n = node()
		const bbox = { minLat: 43.3, maxLat: 43.34, minLon: -95.5, maxLon: -95.44 }

		decorateNode(n, place({ bbox }), [])

		expect(n.metadata?.["resolver_bbox"]).toEqual(bbox)
	})

	it("reads corners a few millionths of a degree apart as a point", () => {
		const n = node()

		decorateNode(
			n,
			place({ bbox: { minLat: 10.7737245, maxLat: 10.7737264, minLon: 106.7165985, maxLon: 106.7166137 } }),
			[]
		)

		expect(n.metadata?.["resolver_bbox"]).toBeUndefined()
	})

	it("records an alias win and leaves a primary-name win unmarked", () => {
		const alias = node()
		const primary = node()

		decorateNode(alias, place({ matchedAlias: true }), [])
		decorateNode(primary, place(), [])

		expect(alias.metadata?.["resolver_matched_alias"]).toBe(true)
		expect(primary.metadata?.["resolver_matched_alias"]).toBeUndefined()
	})

	it("records no extent for a point-only row, whose corners are its coordinate", () => {
		const n = node()

		decorateNode(n, place({ bbox: { minLat: 43.32, maxLat: 43.32, minLon: -95.47, maxLon: -95.47 } }), [])

		expect(n.metadata?.["resolver_bbox"]).toBeUndefined()
	})
})

describe("decorateNode replacing a place the resolver already wrote (#2994)", () => {
	/**
	 * The King's Cross shape: the walk resolved a dependent locality to its London neighborhood,
	 * and a later pass gives the node a same-name locality on the Isle of Arran.
	 */
	const walkPick = (): AddressNode => {
		const n = node({ tag: "dependent_locality", value: "King's Cross", source: "classifier", sourceID: "span:13-25" })

		decorateNode(
			n,
			place({
				id: 85_861_711,
				name: "King's Cross",
				placetype: "neighbourhood",
				country: "GB",
				lat: 51.536114,
				lon: -0.12527,
				importance: 0.4,
				bbox: { minLat: 51.529122, maxLat: 51.541174, minLon: -0.13098, maxLon: -0.116991 },
			}),
			[place({ id: 1 })]
		)

		n.metadata = {
			...n.metadata,
			ancestors: [{ id: 101_750_367, placetype: "locality", name: "London" }],
			contained_by_parent: true,
			admin_containment: "contained",
			explicit_country_repicked: true,
		}

		return n
	}

	const arran = place({
		id: 1_125_788_259,
		name: "Kings Cross",
		placetype: "locality",
		country: "GB",
		lat: 55.521834,
		lon: -5.078258,
	})

	it("removes the previous place's extent, importance, ancestors and containment stamps", () => {
		const n = walkPick()

		decorateNode(n, arran, [])

		expect(n.placeID).toBe("wof:1125788259")
		expect(n.metadata?.["resolver_name"]).toBe("Kings Cross")

		for (const key of [
			"resolver_bbox",
			"resolver_importance",
			"ancestors",
			"contained_by_parent",
			"admin_containment",
		]) {
			expect(n.metadata?.[key], key).toBeUndefined()
		}
	})

	it("keeps the classifier's stamps from the first decoration", () => {
		const n = walkPick()

		decorateNode(n, arran, [])

		expect(n.metadata?.["classifier_source"]).toBe("classifier")
		expect(n.metadata?.["classifier_source_id"]).toBe("span:13-25")
		expect(n.sourceID).toBe("locality:1125788259")
	})

	it("keeps the stamps a pass wrote about the node's history", () => {
		const n = walkPick()

		decorateNode(n, arran, [])

		expect(n.metadata?.["explicit_country_repicked"]).toBe(true)
	})

	it("keeps the stamps of a place written again onto the node that holds it", () => {
		const n = walkPick()

		decorateNode(n, place({ id: 85_861_711, name: "King's Cross", placetype: "neighbourhood", country: "GB" }), [])

		expect(n.metadata?.["ancestors"]).toEqual([{ id: 101_750_367, placetype: "locality", name: "London" }])
		expect(n.metadata?.["contained_by_parent"]).toBe(true)
		expect(n.metadata?.["classifier_source_id"]).toBe("span:13-25")
	})

	it("clears the previous alternatives when the new place has none", () => {
		const n = walkPick()

		decorateNode(n, arran, [])

		expect(n.alternatives).toBeUndefined()
	})
})
