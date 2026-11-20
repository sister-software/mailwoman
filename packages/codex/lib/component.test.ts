// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import type { BIOLabel, ComponentTag } from "#component"
import { bareBIOTag, BIO_LABELS, COMPONENT_TAGS } from "#component"

describe("COMPONENT_TAGS", () => {
	test("every tag is unique", () => {
		const seen = new Set<ComponentTag>(COMPONENT_TAGS)
		expect(seen.size).toBe(COMPONENT_TAGS.length)
	})
})

describe("BIO_LABELS", () => {
	test("length is 1 + 2 * COMPONENT_TAGS.length", () => {
		expect(BIO_LABELS).toHaveLength(1 + 2 * COMPONENT_TAGS.length)
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

describe("bareBIOTag", () => {
	test("strips the B- and I- prefix from every label in the vocabulary", () => {
		for (const tag of COMPONENT_TAGS) {
			expect(bareBIOTag(`B-${tag}`)).toBe(tag)
			expect(bareBIOTag(`I-${tag}`)).toBe(tag)
		}
	})

	test("returns the outside label unchanged rather than an empty string", () => {
		expect(bareBIOTag("O")).toBe("O")
	})

	test("strips only a leading prefix, so a tag containing a hyphen survives", () => {
		expect(bareBIOTag("B-street_prefix_particle")).toBe("street_prefix_particle")
		expect(bareBIOTag("locality")).toBe("locality")
		expect(bareBIOTag("B-B-locality")).toBe("B-locality")
	})
})
