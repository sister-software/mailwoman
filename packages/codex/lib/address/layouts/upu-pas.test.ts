/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { layoutForCountry, layoutPrintsTag } from "#address/layouts"
import { GENERATED_ADDRESS_LAYOUTS } from "#address/layouts/generated"
import { S42_ADDRESS_LAYOUTS } from "#address/layouts/s42"
import { UPU_PAS_ADDRESS_LAYOUTS, UPU_PAS_LAYOUT_RECORDS } from "#address/layouts/upu-pas"
import { joinRendering, renderAddress } from "#address/render"

const rendered = (code: string): string =>
	joinRendering(
		renderAddress(layoutForCountry(code)!, {
			house_number: "1",
			street: "Main",
			street_suffix: "Road",
			dependent_locality: "Elmside",
			locality: "Springfield",
			region: "Shelbyville",
			postcode: "ZZ1 1ZZ",
			country: "Nowhere",
		})
	)

describe("layouts read from a UPU Postal Addressing Systems description", () => {
	it("holds a country only where libaddressinput states no order or omits the locality line", () => {
		// The table fills a gap rather than offering a second reading of a stated order:
		// either the country has no `fmt`, or its `fmt` leaves out the locality the operator prints.
		for (const [code, layout] of Object.entries(UPU_PAS_ADDRESS_LAYOUTS)) {
			const generated = GENERATED_ADDRESS_LAYOUTS[code]

			if (!generated) continue

			expect(layoutPrintsTag(generated, "locality"), code).toBe(false)
			expect(layoutPrintsTag(layout, "locality"), code).toBe(true)
		}
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
