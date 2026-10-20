/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A register can key a borough's or neighborhood's addresses to the city that contains it. The address-point
 *   tier retries such a miss with the resolved locality's WOF ancestors, and both street tiers hold the answer to the
 *   resolved locality's bounding box.
 */

import type { BIOLabel } from "@mailwoman/codex/component"
import { buildAddressTree, collectNodes, type AddressNode } from "@mailwoman/core/decoder"
import type { DecoderToken } from "@mailwoman/core/decoder/types"
import type { AddressPointLookup, Ancestor, InterpolationLookup } from "@mailwoman/core/resolver"
import { describe, expect, test } from "vitest"

import { applyAddressPoint, applyInterpolation } from "#street"

function tok(piece: string, start: number, end: number, label: BIOLabel): DecoderToken {
	return { piece, start, end, label, confidence: 0.9 }
}

const PLACE_ID = 100
const PLACE_BOX = { minLat: 40.72, maxLat: 40.77, minLon: -73.97, maxLon: -73.9 }
const INSIDE = { lat: 40.752, lon: -73.916 }
const OUTSIDE = { lat: 40.651, lon: -74.018 }

const ANCESTORS: Record<number, Ancestor[]> = {
	[PLACE_ID]: [
		{ id: 200, placetype: "borough", name: "Borough" },
		{ id: 300, placetype: "locality", name: "City" },
		{ id: 400, placetype: "county", name: "County" },
		{ id: 500, placetype: "region", name: "Region" },
	],
}

const ancestorsOf = (id: number | string): Ancestor[] => ANCESTORS[Number(id)] ?? []

/**
 * Builds `<number> Main St, Hood` with the locality resolved to {@link PLACE_ID},
 * optionally with a postcode.
 */
function hoodTree(opts: { box?: boolean; postcode?: boolean } = {}) {
	const raw = opts.postcode ? "34 Main St, Hood 11101" : "34 Main St, Hood"

	const tree = buildAddressTree(raw, [
		tok("34", 0, 2, "B-house_number"),
		tok("Main", 3, 7, "B-street"),
		tok("St", 8, 10, "I-street"),
		tok("Hood", 12, 16, "B-locality"),
		...(opts.postcode ? [tok("11101", 17, 22, "B-postcode")] : []),
	])

	const [locality] = collectNodes(tree.roots, (n) => n.tag === "locality")

	locality!.placeID = `wof:${PLACE_ID}`
	locality!.lat = 40.75
	locality!.lon = -73.94

	if (opts.box !== false) {
		locality!.metadata = { ...locality!.metadata, resolver_bbox: PLACE_BOX }
	}

	return tree
}

function streetOf(roots: AddressNode[]): AddressNode {
	return collectNodes(roots, (n) => n.tag === "street")[0]!
}

/**
 * An address-point register that stores every row under one locality name.
 */
function registerKeyedTo(stored: string, at: { lat: number; lon: number }) {
	const localities: Array<string | null | undefined> = []

	const lookup = {
		find(query) {
			localities.push(query.locality)

			return query.locality === stored
				? { ...at, source: "test", release: "r", localityNorm: stored.toLowerCase(), postcode: null }
				: null
		},
	} as AddressPointLookup

	return { lookup, localities }
}

describe("applyAddressPoint's ancestor retry", () => {
	test("answers from the nearest ancestor the register keys its rows to", () => {
		const tree = hoodTree()
		const { lookup, localities } = registerKeyedTo("City", INSIDE)

		applyAddressPoint(tree.roots, lookup, false, ancestorsOf)

		expect(localities).toEqual(["Hood", "Borough", "City"])

		const street = streetOf(tree.roots)
		expect(street.metadata?.["resolution_tier"]).toBe("address_point")
		expect(street.metadata?.["address_point_ancestor_locality"]).toBe("City")
	})

	test("never retries with a county or region ancestor", () => {
		const tree = hoodTree()
		const { lookup, localities } = registerKeyedTo("County", INSIDE)

		applyAddressPoint(tree.roots, lookup, false, ancestorsOf)

		expect(localities).not.toContain("County")
		expect(localities).not.toContain("Region")
		expect(streetOf(tree.roots).metadata?.["resolution_tier"]).toBeUndefined()
	})

	test("refuses an ancestor-keyed row outside the resolved locality's box", () => {
		const tree = hoodTree()
		const { lookup } = registerKeyedTo("City", OUTSIDE)

		applyAddressPoint(tree.roots, lookup, false, ancestorsOf)

		expect(streetOf(tree.roots).metadata?.["resolution_tier"]).toBeUndefined()
	})

	test("does not retry when the resolved locality has no box to hold the row to", () => {
		const tree = hoodTree({ box: false })
		const { lookup, localities } = registerKeyedTo("City", INSIDE)

		applyAddressPoint(tree.roots, lookup, false, ancestorsOf)

		expect(localities).toEqual(["Hood"])
		expect(streetOf(tree.roots).metadata?.["resolution_tier"]).toBeUndefined()
	})

	test("does not retry when the backend gives no lineage", () => {
		const tree = hoodTree()
		const { lookup, localities } = registerKeyedTo("City", INSIDE)

		applyAddressPoint(tree.roots, lookup, false)

		expect(localities).toEqual(["Hood"])
	})

	test("keeps a row the parsed locality's own key answers without consulting the ancestors", () => {
		const tree = hoodTree()
		const { lookup, localities } = registerKeyedTo("Hood", OUTSIDE)

		applyAddressPoint(tree.roots, lookup, false, ancestorsOf)

		expect(localities).toEqual(["Hood"])

		const street = streetOf(tree.roots)
		expect(street.metadata?.["resolution_tier"]).toBe("address_point")
		expect(street.metadata?.["address_point_ancestor_locality"]).toBeUndefined()
	})
})

function interpolatorAt(at: { lat: number; lon: number }): InterpolationLookup {
	return {
		radiusCalibration: null,
		find: () => ({
			...at,
			interpolated: true,
			method: "tiger_range",
			parityMatched: true,
			bracket: null,
			uncertaintyM: 100,
			source: "test",
			release: "r",
		}),
	} as InterpolationLookup
}

describe("applyInterpolation's containment check", () => {
	test("refuses a locality-scoped estimate outside the resolved locality's box", () => {
		const tree = hoodTree()

		applyInterpolation(tree.roots, interpolatorAt(OUTSIDE))

		expect(streetOf(tree.roots).metadata?.["resolution_tier"]).toBeUndefined()
	})

	test("keeps a locality-scoped estimate inside the box", () => {
		const tree = hoodTree()

		applyInterpolation(tree.roots, interpolatorAt(INSIDE))

		expect(streetOf(tree.roots).metadata?.["resolution_tier"]).toBe("interpolated")
	})

	test("keeps a postcode-scoped estimate outside the box, since the postcode scoped the probe", () => {
		const tree = hoodTree({ postcode: true })

		applyInterpolation(tree.roots, interpolatorAt(OUTSIDE))

		expect(streetOf(tree.roots).metadata?.["resolution_tier"]).toBe("interpolated")
	})

	test("keeps an estimate when the resolved locality has no box", () => {
		const tree = hoodTree({ box: false })

		applyInterpolation(tree.roots, interpolatorAt(OUTSIDE))

		expect(streetOf(tree.roots).metadata?.["resolution_tier"]).toBe("interpolated")
	})
})
