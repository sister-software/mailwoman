/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { BIO_LABELS, BIOLabel, COMPONENT_TAGS, ComponentTag } from "./component.js"

describe("COMPONENT_TAGS", () => {
	test("every tag is unique", () => {
		const seen = new Set<ComponentTag>(COMPONENT_TAGS)
		expect(seen.size).toBe(COMPONENT_TAGS.length)
	})

	test("includes universal tags from #5", () => {
		const required: ComponentTag[] = ["country", "region", "locality", "dependent_locality", "postcode", "subregion"]

		for (const tag of required) {
			expect(COMPONENT_TAGS).toContain(tag)
		}
	})

	test("includes the FR-specific cedex tag", () => {
		expect(COMPONENT_TAGS).toContain("cedex")
	})

	test("declares JP tags for forward-compat (Phase 6)", () => {
		const jp: ComponentTag[] = [
			"prefecture",
			"municipality",
			"district",
			"block",
			"sub_block",
			"building_number",
			"building_name",
		]

		for (const tag of jp) {
			expect(COMPONENT_TAGS).toContain(tag)
		}
	})

	test("type narrows from the readonly tuple", () => {
		// Compile-time assertion: ComponentTag is the union of literals.
		const sample: ComponentTag = "country"
		expect(sample satisfies ComponentTag).toBe("country")
	})
})

describe("BIO_LABELS", () => {
	test("starts with the outside-any-component sentinel", () => {
		expect(BIO_LABELS[0]).toBe("O")
	})

	test("length is 1 + 2 * COMPONENT_TAGS.length", () => {
		expect(BIO_LABELS.length).toBe(1 + 2 * COMPONENT_TAGS.length)
	})

	test("contains B- and I- for every tag exactly once", () => {
		const seen = new Set<BIOLabel>(BIO_LABELS)
		expect(seen.size).toBe(BIO_LABELS.length)

		for (const tag of COMPONENT_TAGS) {
			expect(seen.has(`B-${tag}` as BIOLabel)).toBe(true)
			expect(seen.has(`I-${tag}` as BIOLabel)).toBe(true)
		}
	})

	test("B-/I- pairs interleave in COMPONENT_TAGS order", () => {
		for (let i = 0; i < COMPONENT_TAGS.length; i++) {
			const tag = COMPONENT_TAGS[i]!
			expect(BIO_LABELS[1 + 2 * i]).toBe(`B-${tag}`)
			expect(BIO_LABELS[2 + 2 * i]).toBe(`I-${tag}`)
		}
	})
})
