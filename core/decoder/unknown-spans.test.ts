/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */
import { describe, expect, it } from "vitest"

import type { ComponentTag } from "../types/component.ts"
import type { AddressNode, AddressTree } from "./types.ts"
import { isLossless, losslessSegments, unknownSpans } from "./unknown-spans.ts"

function node(tag: ComponentTag, start: number, end: number, value: string, children: AddressNode[] = []): AddressNode {
	return { tag, value, start, end, confidence: 1, children }
}

function tree(raw: string, roots: AddressNode[]): AddressTree {
	return { raw, roots }
}

describe("unknownSpans", () => {
	it("returns nothing when every byte is covered", () => {
		const t = tree("Berlin", [node("locality", 0, 6, "Berlin")])
		expect(unknownSpans(t)).toEqual([])
		expect(isLossless(t)).toBe(true)
	})

	it("captures a gap between two covered spans", () => {
		// "A, B" — locality "A" [0,1), locality "B" [3,4); the ", " [1,3) is the gap.
		const t = tree("A, B", [node("locality", 0, 1, "A"), node("locality", 3, 4, "B")])
		expect(unknownSpans(t)).toEqual([{ kind: "unknown", value: ", ", start: 1, end: 3 }])
		expect(isLossless(t)).toBe(true)
	})

	it("captures a multibyte char fragmented out of a span (the #493 signal)", () => {
		// "Hôtel" parsed as locality "H" [0,1) + locality "tel" [2,5); the "ô" [1,2) drops to all-O.
		const t = tree("Hôtel", [node("locality", 0, 1, "H"), node("locality", 2, 5, "tel")])
		expect(unknownSpans(t)).toEqual([{ kind: "unknown", value: "ô", start: 1, end: 2 }])
		// The round-trip HOLDS precisely because the unknown span captures the dropped char.
		expect(isLossless(t)).toBe(true)
		expect(
			losslessSegments(t)
				.map((s) => s.value)
				.join("")
		).toBe("Hôtel")
	})

	it("merges nested/overlapping node spans without inventing a gap", () => {
		// street [0,16) "East Sheldon Rd" with a street_prefix child [0,4) "East" — overlap must merge.
		const street = node("street", 0, 16, "East Sheldon Rd", [node("street_prefix", 0, 4, "East")])
		const t = tree("East Sheldon Rd", [street])
		expect(unknownSpans(t)).toEqual([])
		expect(isLossless(t)).toBe(true)
	})

	it("captures leading and trailing gaps", () => {
		// "  X " — only X [2,3) is covered; leading "  " and trailing " " are unknown.
		const t = tree("  X ", [node("house_number", 2, 3, "X")])
		expect(unknownSpans(t)).toEqual([
			{ kind: "unknown", value: "  ", start: 0, end: 2 },
			{ kind: "unknown", value: " ", start: 3, end: 4 },
		])
		expect(isLossless(t)).toBe(true)
	})

	it("handles empty input", () => {
		expect(unknownSpans(tree("", []))).toEqual([])
		expect(isLossless(tree("", []))).toBe(true)
	})

	it("a fully-unlabeled input is one unknown span covering everything", () => {
		const t = tree("???", [])
		expect(unknownSpans(t)).toEqual([{ kind: "unknown", value: "???", start: 0, end: 3 }])
		expect(isLossless(t)).toBe(true)
	})

	it("losslessSegments tiles the input in source order", () => {
		const t = tree("A, B", [node("locality", 0, 1, "A"), node("locality", 3, 4, "B")])
		expect(losslessSegments(t)).toEqual([
			{ kind: "covered", value: "A", start: 0, end: 1 },
			{ kind: "unknown", value: ", ", start: 1, end: 3 },
			{ kind: "covered", value: "B", start: 3, end: 4 },
		])
	})
})
