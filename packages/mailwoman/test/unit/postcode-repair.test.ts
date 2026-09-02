/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1735 pins. The rung's whole contract is its checks: it fires on the recorded contradiction (letter-digit postcode
 *   span, ≥0.9 shape confidence, only misread-family nodes wholly inside it) and on NOTHING else. The veto cases are
 *   the tests that matter — each one is an input the rung must leave byte-identical.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { computeQueryShape } from "@mailwoman/query-shape"
import { repairPostcodeContradiction } from "mailwoman/postcode-repair"
import { describe, expect, it } from "vitest"

function node(tag: string, value: string, start: number, end: number): AddressNode {
	return { tag: tag as AddressNode["tag"], value, start, end, confidence: 0.5, children: [] }
}

function tree(raw: string, roots: AddressNode[]): AddressTree {
	return { raw, roots }
}

function tags(t: AddressTree): string[] {
	return t.roots.map((n) => `${n.tag}:${n.value}`).toSorted()
}

describe("repairPostcodeContradiction (#1735)", () => {
	it("repairs the recorded KT2 6AB misread into a postcode node", () => {
		const t = tree("KT2 6AB", [node("street", "KT2", 0, 3), node("house_number", "6AB", 4, 7)])
		const repaired = repairPostcodeContradiction(t, computeQueryShape("KT2 6AB"))

		expect(repaired).toBe(true)
		expect(tags(t)).toEqual(["postcode:KT2 6AB"])
		expect(t.roots[0]!.metadata).toMatchObject({ repaired: "postcode_shape_contradiction" })
	})

	it("repairs the suffixed form and leaves the country node alone", () => {
		const t = tree("RM10 8AB, UK", [
			node("street", "RM10", 0, 4),
			node("house_number", "8AB", 5, 8),
			node("country", "UK", 10, 12),
		])

		expect(repairPostcodeContradiction(t, computeQueryShape("RM10 8AB, UK"))).toBe(true)
		expect(tags(t)).toEqual(["country:UK", "postcode:RM10 8AB"])
	})

	it("never fires when the span already carries a postcode node", () => {
		const t = tree("KT2 6AB", [node("postcode", "KT2 6AB", 0, 7)])

		expect(repairPostcodeContradiction(t, computeQueryShape("KT2 6AB"))).toBe(false)
		expect(tags(t)).toEqual(["postcode:KT2 6AB"])
	})

	it("is vetoed by a non-misread node overlapping the span", () => {
		// A locality reading over the span means the parse holds a PLAUSIBLE alternative, not a misread.
		const t = tree("KT2 6AB", [node("locality", "KT2 6AB", 0, 7)])

		expect(repairPostcodeContradiction(t, computeQueryShape("KT2 6AB"))).toBe(false)
	})

	it("is vetoed by a misread node extending beyond the format span", () => {
		const t = tree("KT2 6AB Lane", [node("street", "KT2 6AB Lane", 0, 12)])

		expect(repairPostcodeContradiction(t, computeQueryShape("KT2 6AB Lane"))).toBe(false)
		expect(tags(t)).toEqual(["street:KT2 6AB Lane"])
	})

	it("does not consume five-digit formats — 12345 Main St keeps its house number", () => {
		const t = tree("12345 Main St", [
			node("house_number", "12345", 0, 5),
			node("street", "Main", 6, 10),
			node("street_suffix", "St", 11, 13),
		])

		expect(repairPostcodeContradiction(t, computeQueryShape("12345 Main St"))).toBe(false)
		expect(tags(t)).toEqual(["house_number:12345", "street:Main", "street_suffix:St"])
	})

	it("repairs the PO-area misread without touching a real PO Box", () => {
		const po = tree("PO33 4DE", [node("po_box", "PO33 4DE", 0, 8)])

		expect(repairPostcodeContradiction(po, computeQueryShape("PO33 4DE"))).toBe(true)
		expect(tags(po)).toEqual(["postcode:PO33 4DE"])

		// A genuine PO Box surface carries no letter-digit postcode span — the format check never opens.
		const box = tree("PO Box 123", [node("po_box", "PO Box 123", 0, 10)])

		expect(repairPostcodeContradiction(box, computeQueryShape("PO Box 123"))).toBe(false)
		expect(tags(box)).toEqual(["po_box:PO Box 123"])
	})

	it("never eats a US house number + directional — the nl_postcode collision that removed NL from the set", () => {
		const t = tree("3215 SE Clinton St, Portland OR", [
			node("house_number", "3215", 0, 4),
			node("street", "SE Clinton", 5, 15),
			node("street_suffix", "St", 16, 18),
			node("locality", "Portland", 20, 28),
			node("region", "OR", 29, 31),
		])

		expect(repairPostcodeContradiction(t, computeQueryShape("3215 SE Clinton St, Portland OR"))).toBe(false)
		expect(tags(t)).toContain("house_number:3215")
	})

	it("is idempotent through the alternate-register retry", () => {
		const t = tree("KT2 6AB", [node("street", "KT2", 0, 3), node("house_number", "6AB", 4, 7)])
		const shape = computeQueryShape("KT2 6AB")

		expect(repairPostcodeContradiction(t, shape)).toBe(true)
		expect(repairPostcodeContradiction(t, shape)).toBe(false)
		expect(tags(t)).toEqual(["postcode:KT2 6AB"])
	})
})
