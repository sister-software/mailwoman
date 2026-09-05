/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The street tiers probe `(street, house_number)` pairs nearest-first and stamp the pair the register answered
 *   for. `Bar 1802, 22 Rue Pascal, 75005 Paris, France` parses two house numbers; `22` sits beside `Rue Pascal`, so it
 *   is probed first, and when the register has it, `22` is the number the result names.
 */

import { buildAddressTree, collectNodes } from "@mailwoman/core/decoder"
import type { DecoderToken } from "@mailwoman/core/decoder/types"
import type { AddressPointLookup } from "@mailwoman/core/resolver"
import type { BIOLabel } from "@mailwoman/core/types/component"
import { applyAddressPoint, streetNumberPairs } from "@mailwoman/resolver/street"
import { describe, expect, test } from "vitest"

function tok(piece: string, start: number, end: number, label: BIOLabel): DecoderToken {
	return { piece, start, end, label, confidence: 0.9 }
}

const RAW = "Bar 1802, 22 Rue Pascal, 75005 Paris, France"

function barTree() {
	return buildAddressTree(RAW, [
		tok("Bar", 0, 3, "B-venue"),
		tok("1802", 4, 8, "B-house_number"),
		tok("22", 10, 12, "B-house_number"),
		tok("Rue", 13, 16, "B-street"),
		tok("Pascal", 17, 23, "I-street"),
		tok("75005", 25, 30, "B-postcode"),
		tok("Paris", 31, 36, "B-locality"),
		tok("France", 38, 44, "B-country"),
	])
}

describe("streetNumberPairs", () => {
	test("orders the house number written beside the street first", () => {
		const pairs = streetNumberPairs(barTree().roots)

		expect(pairs.map((pair) => `${pair.houseNumber.value} ${pair.street.value}`)).toEqual([
			"22 Rue Pascal",
			"1802 Rue Pascal",
		])
	})
})

describe("applyAddressPoint", () => {
	test("probes the nearest pair first and stamps the number the register answered for", () => {
		const tree = barTree()
		const probed: string[] = []

		const lookup: AddressPointLookup = {
			find(query) {
				probed.push(query.number)

				return query.number === "22" ? { lat: 48.84, lon: 2.35, source: "test", release: "r" } : undefined
			},
		} as AddressPointLookup

		applyAddressPoint(tree.roots, lookup)

		expect(probed).toEqual(["22"])

		const numbers = collectNodes(tree.roots, (n) => n.tag === "house_number")
		expect(numbers.find((n) => n.value === "22")?.metadata?.["resolution_tier"]).toBe("address_point")
		expect(numbers.find((n) => n.value === "1802")?.metadata).toBeUndefined()
	})

	test("falls through to the next pair when the nearest one is not in the register", () => {
		const tree = barTree()
		const probed: string[] = []

		const lookup: AddressPointLookup = {
			find(query) {
				probed.push(query.number)

				return query.number === "1802" ? { lat: 48.84, lon: 2.35, source: "test", release: "r" } : undefined
			},
		} as AddressPointLookup

		applyAddressPoint(tree.roots, lookup)

		expect(probed).toEqual(["22", "1802"])
	})
})
