/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { isShapeExcludedPostcode, POSTCODE_SHAPE_EXCLUDED_KEY } from "#decoder/excluded-span"
import { decodeAsJSON } from "#decoder/serialize/json"
import { slotNodes } from "#decoder/tree/walk"
import type { AddressNode } from "#decoder/types"

const node = (tag: AddressNode["tag"], value: string, metadata?: AddressNode["metadata"]): AddressNode => ({
	tag,
	value,
	start: 0,
	end: value.length,
	confidence: 0.9,
	children: [],
	...(metadata ? { metadata } : {}),
})

describe("isShapeExcludedPostcode", () => {
	it("recognizes only a stamped postcode span", () => {
		expect(isShapeExcludedPostcode(node("postcode", "94103"))).toBe(false)
		expect(isShapeExcludedPostcode(node("postcode", "2238", { [POSTCODE_SHAPE_EXCLUDED_KEY]: true }))).toBe(true)
		expect(isShapeExcludedPostcode(node("house_number", "2238", { [POSTCODE_SHAPE_EXCLUDED_KEY]: true }))).toBe(false)
	})

	it("keeps an excluded span out of the slots while the tree keeps its text", () => {
		const excluded = node("postcode", "2238", { [POSTCODE_SHAPE_EXCLUDED_KEY]: true })
		const roots = [node("house_number", "215"), excluded]

		expect(slotNodes(roots)).not.toContain(excluded)
		expect(decodeAsJSON({ raw: "215 2238", roots })).toEqual({ house_number: "215" })
		expect(roots[1]!.value).toBe("2238")
	})
})
