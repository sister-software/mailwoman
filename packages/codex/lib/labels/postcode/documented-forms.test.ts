// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { isAlternation, isLayout, isSlot, type AddressAtom, type AddressSlot } from "#address/layout"
import { layoutForCountry } from "#address/layouts"
import { POSTCODE_PREFIX_RECORDS } from "#labels/postcode/documented-forms"

/**
 * Every postcode slot `atom` holds, through nested layouts and alternations.
 */
function postcodeSlots(atom: AddressAtom): AddressSlot[] {
	if (isSlot(atom)) return atom.tag === "postcode" ? [atom] : []

	if (isAlternation(atom)) return atom.alternatives.flatMap(postcodeSlots)

	if (isLayout(atom)) return atom.lines.flat().flatMap(postcodeSlots)

	return []
}

describe("a country's documented postcode forms", () => {
	// Whichever table renders the country, the forms come from its record: a country moved
	// from the generated table to a UPU reading once lost its bare domestic form this way.
	it.each(Object.keys(POSTCODE_PREFIX_RECORDS))("reach %s's rendered postcode slot", (code) => {
		const layout = layoutForCountry(code)

		expect(layout, `${code} renders no layout`).not.toBeNull()

		const slots = postcodeSlots(layout!)
		const [first, ...others] = POSTCODE_PREFIX_RECORDS[code]!.forms

		expect(slots.length, `${code} prints its postcode`).toBeGreaterThan(0)

		for (const slot of slots) {
			expect(slot.prefix ?? "", code).toBe(first!.prefix)
			expect(slot.otherForms ?? [], code).toEqual(others.map(({ prefix, share }) => ({ prefix, share })))
		}
	})
})
