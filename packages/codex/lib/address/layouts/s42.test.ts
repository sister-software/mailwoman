/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { layoutForCountry } from "#address/layouts"
import { GENERATED_ADDRESS_LAYOUTS } from "#address/layouts/generated"
import { S42_ADDRESS_LAYOUTS, S42_LAYOUT_RECORDS } from "#address/layouts/s42"
import { joinRendering, renderAddress } from "#address/render"
import { S42_TEMPLATE_JURISDICTIONS } from "#address/s42-templates"

describe("layouts read from a UPU Standardized Address Format Description", () => {
	it("covers a jurisdiction only where libaddressinput states no print order", () => {
		// The table exists to fill the gap the generated skeletons leave.
		// An entry for a country that already has a `fmt` would state a second order for it,
		// and `layoutForCountry` would then choose between two readings rather than report both.
		for (const code of Object.keys(S42_ADDRESS_LAYOUTS)) {
			expect(GENERATED_ADDRESS_LAYOUTS[code], code).toBeUndefined()
		}
	})

	it("carries a record beside every layout, and a layout beside every record", () => {
		expect(Object.keys(S42_ADDRESS_LAYOUTS).toSorted()).toEqual(Object.keys(S42_LAYOUT_RECORDS).toSorted())
	})

	it("names only jurisdictions that hold an approved S42 template", () => {
		const templates = new Set(S42_TEMPLATE_JURISDICTIONS)

		for (const code of Object.keys(S42_ADDRESS_LAYOUTS)) {
			expect(templates.has(code), code).toBe(true)
		}
	})

	it("gives a country a layout where it had none", () => {
		for (const code of Object.keys(S42_ADDRESS_LAYOUTS)) {
			expect(layoutForCountry(code), code).toBe(S42_ADDRESS_LAYOUTS[code])
		}
	})

	it("records what each SAFD states about its own registration", () => {
		for (const [code, record] of Object.entries(S42_LAYOUT_RECORDS)) {
			expect(record.approvedAt, code).toMatch(/^\d{4}-\d{1,2}$/u)
			expect(record.reviewedAt, code).toMatch(/^\d{4}-\d{1,2}$/u)
			expect(record.sampleSize, code).toBeGreaterThanOrEqual(0)
			expect(record.unexpressed.length, code).toBeGreaterThan(0)
		}
	})

	it("prints a postcode exactly where the template's own reading says", () => {
		// The position is what libaddressinput's null `fmt` left unstated for all eight,
		// so it is checked against a rendered address rather than against the layout's shape.
		const rendered = (code: string): string =>
			joinRendering(
				renderAddress(layoutForCountry(code)!, {
					house_number: "1",
					street: "Main",
					street_suffix: "Road",
					locality: "Springfield",
					region: "Springfield",
					dependent_locality: "Elmside",
					postcode: "ZZ1 1ZZ",
					country: "Nowhere",
				})
			)

		for (const [code, record] of Object.entries(S42_LAYOUT_RECORDS)) {
			const text = rendered(code)

			if (record.postcode === "absent") {
				expect(text, code).not.toContain("ZZ1 1ZZ")

				continue
			}

			expect(text, code).toContain("ZZ1 1ZZ")

			const postcodeAt = text.indexOf("ZZ1 1ZZ")
			const localityAt = text.indexOf("Springfield")

			if (record.postcode === "before-locality") {
				expect(postcodeAt, code).toBeLessThan(localityAt)
			} else {
				expect(postcodeAt, code).toBeGreaterThan(localityAt)
			}
		}
	})

	it("holds the three jurisdictions whose template registers no postcode", () => {
		// Botswana, Qatar and Zimbabwe each publish a SAFD with no postcode element.
		// A reader that assumes every country has one would invent a field for these three.
		const absent = Object.entries(S42_LAYOUT_RECORDS)
			.filter(([, record]) => record.postcode === "absent")
			.map(([code]) => code)

		expect(absent.toSorted()).toEqual(["BW", "QA", "ZW"])
	})
})
