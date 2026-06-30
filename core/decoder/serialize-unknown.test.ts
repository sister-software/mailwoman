/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The opt-in `unknown` surface across the three serializers (#493). Default-off everywhere — the existing
 *   shapes (libpostal-compat JSON, tag-only tuples, the XML elements) are byte-stable unless asked.
 */
import { describe, expect, it } from "vitest"

import type { ComponentTag } from "../types/component.js"
import { decodeAsJSON } from "./serialize-json.js"
import { decodeAsTuples } from "./serialize-tuples.js"
import { decodeAsXML } from "./serialize-xml.js"
import type { AddressNode, AddressTree } from "./types.js"

function node(tag: ComponentTag, start: number, end: number, value: string, children: AddressNode[] = []): AddressNode {
	return { tag, value, start, end, confidence: 1, children }
}

// "A, B" — locality "A" [0,1), locality "B" [3,4); the ", " [1,3) is the unknown gap.
const tree: AddressTree = { raw: "A, B", roots: [node("locality", 0, 1, "A"), node("locality", 3, 4, "B")] }
const noGap: AddressTree = { raw: "Berlin", roots: [node("locality", 0, 6, "Berlin")] }

describe("decodeAsJSON includeUnknown", () => {
	it("is byte-stable by default (no unknown key)", () => {
		expect(decodeAsJSON(tree)).toEqual({ locality: "A" })
		expect("unknown" in decodeAsJSON(tree)).toBe(false)
	})

	it("adds the unknown array when asked", () => {
		expect(decodeAsJSON(tree, { includeUnknown: true })).toEqual({
			locality: "A",
			unknown: [{ kind: "unknown", value: ", ", start: 1, end: 3 }],
		})
	})

	it("emits an empty unknown array (not omitted) when there are no gaps", () => {
		expect(decodeAsJSON(noGap, { includeUnknown: true })).toEqual({ locality: "Berlin", unknown: [] })
	})
})

describe("decodeAsTuples includeUnknown", () => {
	it("is byte-stable by default (tag-only)", () => {
		expect(decodeAsTuples(tree)).toEqual([
			["locality", "A"],
			["locality", "B"],
		])
	})

	it("interleaves unknown tuples in source order", () => {
		expect(decodeAsTuples(tree, { includeUnknown: true })).toEqual([
			["locality", "A"],
			["unknown", ", "],
			["locality", "B"],
		])
	})
})

describe("decodeAsXML includeUnknown", () => {
	it("is byte-stable by default (no <unknown>)", () => {
		expect(decodeAsXML(tree, { pretty: false })).not.toContain("<unknown")
	})

	it("emits source-ordered <unknown> elements when asked", () => {
		const xml = decodeAsXML(tree, { pretty: false, includeUnknown: true })
		expect(xml).toContain('<unknown start="1" end="3">, </unknown>')
		// Source order: locality A, then the gap, then locality B.
		expect(xml.indexOf("A</locality>")).toBeLessThan(xml.indexOf("<unknown"))
		expect(xml.indexOf("<unknown")).toBeLessThan(xml.indexOf("B</locality>"))
	})
})
