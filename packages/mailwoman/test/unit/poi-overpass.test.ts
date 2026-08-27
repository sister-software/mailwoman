/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { POIIntent } from "@mailwoman/core/pipeline"
import { emitOverpassQL } from "mailwoman/poi-overpass"
import { describe, expect, it } from "vitest"

const category = (anchor?: POIIntent["anchor"]): POIIntent => ({
	subject: { kind: "category", categoryIDs: ["hospital"], matched: "hospital" },
	...(anchor ? { anchor } : {}),
})

describe("emitOverpassQL", () => {
	it("emits a global tag query for a bare category", () => {
		const ql = emitOverpassQL(category(), { osmTags: ["amenity=hospital"] })
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
			{ osmTags: ["amenity=hospital"] }
		)

		expect(ql).toContain('area["name"="Springfield"]->.anchor')
		expect(ql).toContain('nwr["amenity"="hospital"](area.anchor)')
	})

	// A subject reaching several categories asks Overpass for the same set the POI branch searched. The union block is
	// the language's own way of saying it, and the members sit inside it in the subject's order with no preference
	// between them.
	it("emits a union block for a category subject reaching several categories", () => {
		const ql = emitOverpassQL(
			{ subject: { kind: "category", categoryIDs: ["drugstore", "pharmacy"], matched: "prescription" } },
			{ osmTags: ["shop=chemist", "amenity=pharmacy"] }
		)

		expect(ql).toContain('(nwr["shop"="chemist"];nwr["amenity"="pharmacy"];);')
	})

	it("scopes every member of a union to the anchor area", () => {
		const ql = emitOverpassQL(
			{
				subject: { kind: "category", categoryIDs: ["drugstore", "pharmacy"], matched: "prescription" },
				anchor: { text: "Coalinga CA", tree: { roots: [{ tag: "locality", value: "Coalinga" }] } },
			},
			{ osmTags: ["shop=chemist", "amenity=pharmacy"] }
		)

		expect(ql).toContain('(nwr["shop"="chemist"](area.anchor);nwr["amenity"="pharmacy"](area.anchor););')
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
		const intent: POIIntent = { subject: { kind: "category", categoryIDs: ["x"], matched: "x" } }
		expect(() => emitOverpassQL(intent, { osmTags: ["amenity"] })).toThrow(/malformed osmTag/)
		expect(() => emitOverpassQL(intent, { osmTags: ["a=b=c"] })).toThrow(/malformed osmTag/)
		expect(() => emitOverpassQL(intent, { osmTags: ["=value"] })).toThrow(/malformed osmTag/)
	})
})
