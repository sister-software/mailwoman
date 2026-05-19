/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"
import type { BioLabel } from "../types/component.js"
import { buildAddressTree } from "./build-tree.js"
import type { AddressNode, DecoderToken } from "./types.js"

/** Construct a DecoderToken — confidence defaults to 1.0 for fixture brevity. */
function tok(piece: string, start: number, end: number, label: BioLabel, confidence = 1): DecoderToken {
	return { piece, start, end, label, confidence }
}

/**
 * "1600 Pennsylvania Avenue NW, Washington, DC 20500" 0 5 18 25 29 41 44
 */
function whiteHouseTokens(): DecoderToken[] {
	return [
		tok("1600", 0, 4, "B-house_number"),
		tok("Pennsylvania", 5, 17, "B-street"),
		tok("Avenue", 18, 24, "I-street"),
		tok("NW", 25, 27, "I-street"),
		tok(",", 27, 28, "O"),
		tok("Washington", 29, 39, "B-locality"),
		tok(",", 39, 40, "O"),
		tok("DC", 41, 43, "B-region"),
		tok("20500", 44, 49, "B-postcode"),
	]
}

const WHITE_HOUSE = "1600 Pennsylvania Avenue NW, Washington, DC 20500"

describe("buildAddressTree", () => {
	test("emits one span per B-/I- group, dropping O", () => {
		const tree = buildAddressTree(WHITE_HOUSE, whiteHouseTokens())
		// 5 spans: house_number, street, locality, region, postcode
		const allTags: string[] = []
		const collect = (n: AddressNode): void => {
			allTags.push(n.tag)
			for (const c of n.children) collect(c)
		}
		for (const r of tree.roots) collect(r)
		expect(allTags.sort()).toEqual(["house_number", "locality", "postcode", "region", "street"])
	})

	test("groups B-street + I-street + I-street into one street span sliced from raw", () => {
		const tree = buildAddressTree(WHITE_HOUSE, whiteHouseTokens())
		const street = findByTag(tree.roots, "street")!
		expect(street.value).toBe("Pennsylvania Avenue NW")
		expect(street.start).toBe(5)
		expect(street.end).toBe(27)
	})

	test("nests house_number under street", () => {
		const tree = buildAddressTree(WHITE_HOUSE, whiteHouseTokens())
		const street = findByTag(tree.roots, "street")!
		expect(street.children.map((c) => c.tag)).toContain("house_number")
	})

	test("nests street + postcode under locality (containment, not source order)", () => {
		const tree = buildAddressTree(WHITE_HOUSE, whiteHouseTokens())
		const locality = findByTag(tree.roots, "locality")!
		const childTags = locality.children.map((c) => c.tag)
		expect(childTags).toContain("street")
		expect(childTags).toContain("postcode")
	})

	test("nests locality under region; region is the only root", () => {
		const tree = buildAddressTree(WHITE_HOUSE, whiteHouseTokens())
		expect(tree.roots.length).toBe(1)
		expect(tree.roots[0]!.tag).toBe("region")
		expect(tree.roots[0]!.children.map((c) => c.tag)).toEqual(["locality"])
	})

	test("source order preserved in sibling sort (street before postcode under locality)", () => {
		const tree = buildAddressTree(WHITE_HOUSE, whiteHouseTokens())
		const locality = findByTag(tree.roots, "locality")!
		expect(locality.children.map((c) => c.tag)).toEqual(["street", "postcode"])
	})

	test("hanging I- with no prior B- starts a new span (lenient recovery)", () => {
		const raw = "Paris"
		const tokens: DecoderToken[] = [tok("Paris", 0, 5, "I-locality")]
		const tree = buildAddressTree(raw, tokens)
		expect(tree.roots[0]?.tag).toBe("locality")
		expect(tree.roots[0]?.value).toBe("Paris")
	})

	test("confidence is the mean of token confidences across the span", () => {
		const raw = "Pennsylvania Avenue"
		const tokens: DecoderToken[] = [tok("Pennsylvania", 0, 12, "B-street", 0.8), tok("Avenue", 13, 19, "I-street", 0.6)]
		const tree = buildAddressTree(raw, tokens)
		expect(tree.roots[0]!.confidence).toBeCloseTo(0.7, 5)
	})

	test("postcode-before-locality still attaches to locality (nearest-parent rule)", () => {
		// "75004 Paris"
		const raw = "75004 Paris"
		const tokens: DecoderToken[] = [tok("75004", 0, 5, "B-postcode"), tok("Paris", 6, 11, "B-locality")]
		const tree = buildAddressTree(raw, tokens)
		const locality = findByTag(tree.roots, "locality")!
		expect(locality.children.map((c) => c.tag)).toEqual(["postcode"])
	})
})

function findByTag(nodes: AddressNode[], tag: string): AddressNode | null {
	for (const n of nodes) {
		if (n.tag === tag) return n
		const inChild = findByTag(n.children, tag)
		if (inChild) return inChild
	}
	return null
}
