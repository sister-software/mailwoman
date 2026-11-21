// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Every rendering the corpus writes of one NAD record keys to one address.
 */

import { describe, expect, it } from "vitest"

import { AUGMENTATIONS } from "#synthesizers/utils"
import type { CanonicalRow } from "#types"
import { nadAddressBlock, nadAddressKey } from "#us/adapters/usgov/nad/address-key"
import { alignRow } from "#utils"

const record = (over: Partial<CanonicalRow> = {}): CanonicalRow => ({
	raw: "8634 North Vernon Avenue Apartment 2, Alexandria, VA 22309-1234",
	components: {
		house_number: "8634",
		street_prefix: "North",
		street: "Vernon",
		street_suffix: "Avenue",
		unit: "Apartment 2",
		locality: "Alexandria",
		region: "VA",
		postcode: "22309-1234",
	},
	country: "US",
	source: "usgov-nad",
	source_id: "usgov-nad-f4f0f39f-7883-4d3e-a871-7038697fcf58-f2b97d34ccd0",
	license: "LicenseRef-Public-Domain",
	...over,
})

function keyOf(row: CanonicalRow): string | null {
	const aligned = alignRow(row)

	if (aligned.kind !== "labeled") throw new Error(`${row.raw} did not align: ${aligned.row.reason}`)

	return nadAddressKey({
		raw: aligned.row.raw,
		span_starts: aligned.row.span_starts!,
		span_ends: aligned.row.span_ends!,
		span_tags: aligned.row.span_tags!,
	})
}

describe("nadAddressKey", () => {
	const base = keyOf(record())

	it("reads state, ZIP Code, number, street and unit", () => {
		expect(base).toBe("va|22309|8634|n vernon avenue|apartment 2")
	})

	it("gives every augmentation of the record the record's key, except an injected typo", () => {
		// The suffix augmentations rewrite a suffix written inside the street component.
		const unsplit = record({
			components: { ...record().components, street: "Vernon Avenue", street_suffix: undefined },
		})

		const rendered = [record(), unsplit].flatMap((source) =>
			Object.entries(AUGMENTATIONS).flatMap(([name, augment]) => {
				const row = augment(source)

				return row ? [[name, keyOf(row)] as const] : []
			})
		)

		// The fixtures exercise every rewrite the US augmentations make.
		expect(rendered.map(([name]) => name)).toEqual(
			expect.arrayContaining([
				"state-expand",
				"directional-abbreviate",
				"us-street-suffix-abbreviate",
				"us-unit-designator-abbreviate",
				"zip-plus4-dash-drop",
			])
		)

		// A typo changes the address text.
		// The split sends such a variant to test with its group.
		for (const [name, key] of rendered.filter(([augmentation]) => augmentation !== "typo-inject")) {
			expect([name, key]).toEqual([name, base])
		}
	})

	it("joins a re-ingested record of the same address and keeps another address apart", () => {
		const reingested = record({ source_id: "usgov-nad-58de9631-abd3-41ea-b44d-4d239ddd766a-f2b97d34ccd0" })

		expect(keyOf(reingested)).toBe(base)

		expect(
			keyOf(
				record({
					raw: record().raw.replace("8634", "8636"),
					components: { ...record().components, house_number: "8636" },
				})
			)
		).not.toBe(base)
	})

	it("names no address without a ZIP Code or a house number", () => {
		const { postcode: _, ...noPostcode } = record().components

		expect(
			keyOf(record({ raw: "8634 North Vernon Avenue Apartment 2, Alexandria, VA", components: noPostcode }))
		).toBeNull()

		expect(nadAddressBlock({ raw: "Main St", span_starts: [0], span_ends: [7], span_tags: ["street"] })).toBeNull()
	})
})
