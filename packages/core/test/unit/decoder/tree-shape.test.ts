/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `walkNodes` yields document order, so a `find` over it and the flat component map name the SAME span when a tag
 *   occurs twice. The pair that showed the two disagreeing: `Village of Fae, Camino Real, Carmel-By-The-Sea, CA 93921`,
 *   two `venue` spans, where the named slot answered the second and the map the first.
 */

import { collectNodes, decodeAsJSON, slotNodes, walkNodes } from "@mailwoman/core/decoder"
import { buildAddressTree } from "@mailwoman/core/decoder/build-tree"
import { describe, expect, test } from "vitest"

import { tok } from "./fixtures.ts"

const RAW = "Village of Fae, Camino Real, Carmel-By-The-Sea, CA 93921"

function twoVenueTokens() {
	return [
		tok("Village", 0, 7, "B-venue"),
		tok("of", 8, 10, "I-venue"),
		tok("Fae", 11, 14, "I-venue"),
		tok("Camino", 16, 22, "B-venue"),
		tok("Real", 23, 27, "I-venue"),
		tok("Carmel-By-The-Sea", 29, 46, "B-locality"),
		tok("CA", 48, 50, "B-region"),
		tok("93921", 51, 56, "B-postcode"),
	]
}

describe("walkNodes", () => {
	test("yields siblings in text order, parent before children", () => {
		const tree = buildAddressTree(RAW, twoVenueTokens())
		const starts = [...walkNodes(tree.roots)].map((n) => n.start)

		for (const root of tree.roots) {
			for (const child of root.children) {
				expect(starts.indexOf(root.start)).toBeLessThan(starts.indexOf(child.start))
			}
		}

		const rootStarts = tree.roots.map((n) => n.start)
		const rootOrderInWalk = starts.filter((s) => rootStarts.includes(s))
		expect(rootOrderInWalk).toEqual(rootStarts.toSorted((a, b) => a - b))
	})

	test("the first same-tag span in the walk is the one the flat component map keeps", () => {
		const tree = buildAddressTree(RAW, twoVenueTokens())
		const firstVenue = collectNodes(tree.roots, (n) => n.tag === "venue")[0]!

		expect(firstVenue.value).toBe("Village of Fae")
		expect(decodeAsJSON(tree).venue).toBe("Village of Fae")
	})
})

describe("slotNodes", () => {
	test("a grounded span outranks an earlier ungrounded span of the same tag; ungrounded pairs keep text order", () => {
		const raw = "12 MG Road, Indiranagar, Bengaluru, Karnataka 560038, India"

		const tree = buildAddressTree(raw, [
			tok("12", 0, 2, "B-house_number"),
			tok("MG", 3, 5, "B-street"),
			tok("Road", 6, 10, "B-street_suffix"),
			tok("Indiranagar", 12, 23, "B-dependent_locality"),
			tok("Bengaluru", 25, 34, "B-locality"),
			tok("Karnataka", 36, 45, "B-locality"),
			tok("560038", 46, 52, "B-postcode"),
			tok("India", 54, 59, "B-country"),
		])

		const localities = collectNodes(tree.roots, (n) => n.tag === "locality")
		expect(localities.map((n) => n.value)).toEqual(["Bengaluru", "Karnataka"])

		// Nothing grounded: text order, and the component map agrees.
		expect(slotNodes(tree.roots).find((n) => n.tag === "locality")?.value).toBe("Bengaluru")
		expect(decodeAsJSON(tree).locality).toBe("Bengaluru")

		// The resolver grounds the LATER span only: it now holds the slot in both projections.
		localities[1]!.lat = 15.3
		localities[1]!.lon = 75.7
		localities[1]!.placeID = "wof:85688457"
		expect(slotNodes(tree.roots).find((n) => n.tag === "locality")?.value).toBe("Karnataka")
		expect(decodeAsJSON(tree).locality).toBe("Karnataka")

		expect(decodeAsJSON(tree, { includeDropped: true }).dropped).toEqual([
			{ tag: "locality", value: "Bengaluru", kept: "Karnataka" },
		])
	})

	test("a resolution-tier stamp grounds a span the same way a coordinate does", () => {
		const raw = "Bar 1802, 22 Rue Pascal, 75005 Paris, France"

		const tree = buildAddressTree(raw, [
			tok("Bar", 0, 3, "B-venue"),
			tok("1802", 4, 8, "B-house_number"),
			tok("22", 10, 12, "B-house_number"),
			tok("Rue", 13, 16, "B-street"),
			tok("Pascal", 17, 23, "I-street"),
			tok("75005", 25, 30, "B-postcode"),
			tok("Paris", 31, 36, "B-locality"),
			tok("France", 38, 44, "B-country"),
		])

		const numbers = collectNodes(tree.roots, (n) => n.tag === "house_number")
		expect(numbers.map((n) => n.value)).toEqual(["1802", "22"])
		expect(decodeAsJSON(tree).house_number).toBe("1802")

		numbers[1]!.metadata = { resolution_tier: "address_point" }
		expect(slotNodes(tree.roots).find((n) => n.tag === "house_number")?.value).toBe("22")
		expect(decodeAsJSON(tree).house_number).toBe("22")
	})
})
