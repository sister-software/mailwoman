/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the v0.7 #37 structural-validity checker. Trees are built through the real
 *   `buildAddressTree` (so containment matches production) except for the illegal-edge case, which
 *   is hand-constructed since the builder only produces legal edges by design.
 */

import { buildAddressTree } from "@mailwoman/core/decoder/build-tree"
import type { AddressNode } from "@mailwoman/core/decoder/types"
import { validateTree } from "@mailwoman/core/decoder/validate-tree"
import { describe, expect, test } from "vitest"

import { tok } from "./fixtures.ts"

function node(tag: AddressNode["tag"], value: string, children: AddressNode[] = []): AddressNode {
	return { tag, value, start: 0, end: value.length, confidence: 1, children }
}

describe("validateTree", () => {
	test("a coherent address with a proper anchor chain is valid", () => {
		// "100 Main St" → house_number nests under street (its anchor present).
		const tree = buildAddressTree("100 Main St", [
			tok("100", 0, 3, "B-house_number"),
			tok("Main", 4, 8, "B-street"),
			tok("St", 9, 11, "I-street"),
		])

		const v = validateTree(tree)
		expect(v.valid).toBe(true)
		expect(v.violations).toHaveLength(0)
	})

	test("a house_number with no street anywhere is a stranded dependent", () => {
		const tree = buildAddressTree("100 Springfield", [
			tok("100", 0, 3, "B-house_number"),
			tok("Springfield", 4, 15, "B-locality"),
		])

		const v = validateTree(tree)
		expect(v.valid).toBe(false)
		expect(v.violations.some((x) => x.type === "stranded-dependent" && x.tag === "house_number")).toBe(true)
	})

	test("a dependent_locality with no locality is stranded", () => {
		const tree = buildAddressTree("Williamsburg", [tok("Williamsburg", 0, 12, "B-dependent_locality")])
		const v = validateTree(tree)
		expect(v.violations.some((x) => x.type === "stranded-dependent" && x.tag === "dependent_locality")).toBe(true)
	})

	test("a geographic container standing alone is NOT flagged (postcode-only is valid)", () => {
		const tree = buildAddressTree("90210", [tok("90210", 0, 5, "B-postcode")])
		const v = validateTree(tree)
		expect(v.valid).toBe(true)
	})

	test("a lone locality (container) is not flagged", () => {
		const tree = buildAddressTree("Chicago", [tok("Chicago", 0, 7, "B-locality")])
		expect(validateTree(tree).valid).toBe(true)
	})

	test("an illegal containment edge is detected", () => {
		// Hand-built: a postcode nested under a house_number — house_number is not in
		// PARENT_OF[postcode], so this edge is illegal.
		const tree = {
			raw: "x",
			roots: [node("house_number", "100", [node("postcode", "90210")])],
		}

		const v = validateTree(tree)
		expect(v.violations.some((x) => x.type === "illegal-edge" && x.tag === "postcode")).toBe(true)
	})

	test("a unit anchored by a VENUE is valid — the sub-venue case the contract used to omit", () => {
		// `Terminal 5, Heathrow Airport, Hounslow, TW6 2GA` parses to exactly this shape and is a CONDITIONAL PASS on the
		// board. Before `venue` joined PARENT_OF[unit] the checker called it a stranded dependent, so the contract was
		// narrower than the capability already being tested — the checker was wrong, not the parse.
		const tree = {
			raw: "Terminal 5, Heathrow Airport, Hounslow",
			roots: [node("venue", "Heathrow Airport"), node("unit", "Terminal 5"), node("locality", "Hounslow")],
		}

		expect(validateTree(tree).valid).toBe(true)
	})

	test("a unit with NO anchor of any kind is still stranded", () => {
		// Widening the contract must not make the check vacuous: a unit alone has nothing to belong to.
		const tree = { raw: "Terminal 5", roots: [node("unit", "Terminal 5")] }

		expect(validateTree(tree).violations.some((x) => x.type === "stranded-dependent" && x.tag === "unit")).toBe(true)
	})
})
