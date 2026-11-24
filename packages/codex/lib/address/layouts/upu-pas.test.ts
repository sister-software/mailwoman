// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { layoutForCountry, layoutPrintsTag } from "#address/layouts"
import { GENERATED_ADDRESS_LAYOUTS } from "#address/layouts/generated"
import { S42_ADDRESS_LAYOUTS } from "#address/layouts/s42"
import { UPUAdmission, UPU_PAS_ADDRESS_LAYOUTS, UPU_PAS_LAYOUT_RECORDS } from "#address/layouts/upu-pas"
import { joinRendering, renderAddress } from "#address/render"

const SAMPLE = {
	house_number: "1",
	street: "Main",
	street_suffix: "Road",
	dependent_locality: "Elmside",
	locality: "Springfield",
	region: "Shelbyville",
	postcode: "ZZ1 1ZZ",
	country: "Nowhere",
}

const rendered = (code: string): string => joinRendering(renderAddress(layoutForCountry(code)!, SAMPLE))

describe("layouts read from a UPU Postal Addressing Systems description", () => {
	it("holds a country only for the reason its record states, checked against the skeleton", () => {
		// The country has no `fmt`, its `fmt` leaves out the locality the operator prints,
		// or its `fmt` orders the locality line differently from the operator's examples.
		for (const [code, layout] of Object.entries(UPU_PAS_ADDRESS_LAYOUTS)) {
			const generated = GENERATED_ADDRESS_LAYOUTS[code]
			const reason = UPU_PAS_LAYOUT_RECORDS[code]!.admittedBecause

			expect(layoutPrintsTag(layout, "locality"), code).toBe(true)

			if (reason === UPUAdmission.NoFormat) {
				expect(generated, code).toBeUndefined()
			} else if (reason === UPUAdmission.FormatOmitsLocality) {
				expect(layoutPrintsTag(generated!, "locality"), code).toBe(false)
			} else {
				// The skeleton prints the locality, and the description's rendering differs from it.
				expect(layoutPrintsTag(generated!, "locality"), code).toBe(true)
				expect(rendered(code), code).not.toBe(joinRendering(renderAddress(generated!, SAMPLE)))
			}
		}
	})

	it("writes the locality right after the postcode where the description prints `postcode locality`", () => {
		// Romania's examples print `060274 BUCHAREST`; libaddressinput's `%Z %S %C` put the county between them.
		expect(rendered("RO")).toContain("ZZ1 1ZZ Springfield")
		expect(rendered("RO")).not.toContain("Shelbyville")
		// Latvia's national register writes the municipality between the locality and the postcode.
		expect(rendered("LV")).toContain("Springfield, Shelbyville, ZZ1 1ZZ")
		// Kiribati's examples print the island with its postcode and never the island group.
		expect(rendered("KI")).toContain("Springfield ZZ1 1ZZ")
		expect(rendered("KI")).not.toContain("Shelbyville")
	})

	it("never states a second order for a country a SAFD already covers", () => {
		for (const code of Object.keys(UPU_PAS_ADDRESS_LAYOUTS)) {
			expect(S42_ADDRESS_LAYOUTS[code], code).toBeUndefined()
		}
	})

	it("carries a record beside every layout, and a layout beside every record", () => {
		expect(Object.keys(UPU_PAS_ADDRESS_LAYOUTS).toSorted()).toEqual(Object.keys(UPU_PAS_LAYOUT_RECORDS).toSorted())
	})

	it("is the layout a country renders with", () => {
		for (const code of Object.keys(UPU_PAS_ADDRESS_LAYOUTS)) {
			expect(layoutForCountry(code), code).toBe(UPU_PAS_ADDRESS_LAYOUTS[code])
		}
	})

	it("records which description each layout was read from", () => {
		for (const [code, record] of Object.entries(UPU_PAS_LAYOUT_RECORDS)) {
			expect(record.documentDate, code).toMatch(/^\d{4}-\d{1,2}$/u)
			expect(record.url, code).toMatch(/^https:\/\/www\.upu\.int\/.+En\.pdf$/u)
			expect(record.sha256, code).toMatch(/^[0-9a-f]{64}$/u)
			expect(record.unexpressed.length, code).toBeGreaterThan(0)
		}
	})

	it("prints the locality every description's examples print", () => {
		for (const code of Object.keys(UPU_PAS_ADDRESS_LAYOUTS)) {
			expect(rendered(code), code).toContain("Springfield")
		}
	})

	it("prints a postcode exactly where the description puts it", () => {
		for (const [code, record] of Object.entries(UPU_PAS_LAYOUT_RECORDS)) {
			const text = rendered(code)

			if (record.postcode === "absent") {
				expect(text, code).not.toContain("ZZ1 1ZZ")

				continue
			}

			const postcodeAt = text.indexOf("ZZ1 1ZZ")

			expect(postcodeAt, code).toBeGreaterThan(-1)

			if (record.postcode === "before-locality") {
				expect(postcodeAt, code).toBeLessThan(text.indexOf("Springfield"))
			} else if (record.postcode === "after-locality") {
				expect(postcodeAt, code).toBeGreaterThan(text.indexOf("Springfield"))
			} else {
				expect(postcodeAt, code).toBeLessThan(text.indexOf("Shelbyville"))
				expect(postcodeAt, code).toBeGreaterThan(text.indexOf("Springfield"))
			}
		}
	})
})
