/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { POIIntent } from "@mailwoman/core/pipeline"
import { describe, expect, it } from "vitest"

import { emitOverpassQL } from "./poi-overpass.ts"

const category = (anchor?: POIIntent["anchor"]): POIIntent => ({
	subject: { kind: "category", categoryID: "hospital", matched: "hospital" },
	...(anchor ? { anchor } : {}),
})

describe("emitOverpassQL", () => {
	it("emits a global tag query for a bare category", () => {
		const ql = emitOverpassQL(category(), { osmTag: "amenity=hospital" })
		expect(ql).toContain('nwr["amenity"="hospital"]')
		expect(ql).toContain("[out:json]")
		expect(ql).toContain("out center")
	})

	it("scopes to a named area when the anchor tree resolved a locality", () => {
		const ql = emitOverpassQL(
			category({
				text: "Springfield IL",
				tree: {
					raw: "Springfield IL",
					roots: [
						{ tag: "locality", value: "Springfield", start: 0, end: 11, confidence: 0.9, children: [] },
						{ tag: "region", value: "IL", start: 12, end: 14, confidence: 0.9, children: [] },
					],
				},
			}),
			{ osmTag: "amenity=hospital" }
		)
		expect(ql).toContain('area["name"="Springfield"]->.anchor')
		expect(ql).toContain('nwr["amenity"="hospital"](area.anchor)')
	})

	it("falls back to a name regex for name subjects, with escaping", () => {
		const ql = emitOverpassQL({ subject: { kind: "name", text: 'Joe"s "Diner"' } })
		expect(ql).toContain('nwr["name"~"Joe\\"s \\"Diner\\"",i]')
	})

	it("emits a brand name filter for brand subjects", () => {
		const ql = emitOverpassQL({ subject: { kind: "brand", name: "McDonald's", matched: "mcdonald's" } })
		expect(ql).toContain('nwr["name"~"McDonald\'s",i]')
	})

	it("throws on a category subject with no osmTag provided", () => {
		expect(() => emitOverpassQL(category())).toThrow(/osmTag/)
	})

	it("escapes regex metacharacters in name subjects for the ~ context", () => {
		const ql = emitOverpassQL({ subject: { kind: "name", text: "St. Mary's Hospital (Main)" } })
		expect(ql).toContain(String.raw`nwr["name"~"St\\. Mary's Hospital \\(Main\\)",i]`)
	})

	it("throws on a malformed osmTag", () => {
		const intent: POIIntent = { subject: { kind: "category", categoryID: "x", matched: "x" } }
		expect(() => emitOverpassQL(intent, { osmTag: "amenity" })).toThrow(/malformed osmTag/)
		expect(() => emitOverpassQL(intent, { osmTag: "a=b=c" })).toThrow(/malformed osmTag/)
		expect(() => emitOverpassQL(intent, { osmTag: "=value" })).toThrow(/malformed osmTag/)
	})
})
