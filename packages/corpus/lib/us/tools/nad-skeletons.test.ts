/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import type { NADRecord } from "#us/adapters/usgov/nad/adapter"
import { nadSkeletonRow, nadUnitIdentifier } from "#us/tools/nad-skeletons"

const BASE: NADRecord = {
	UUID: "7fe2b28e-a357-41f5-be2b-27dfe65a2bf7",
	AddNo_Full: "611",
	St_PreDir: "East",
	St_Name: "MAIN",
	St_PosTyp: "Street",
	County: "Dane",
	Post_City: "Madison",
	State: "WI",
	Zip_Code: "53703",
}

describe("nadUnitIdentifier", () => {
	it("drops the designator NAD wrote, because the recipes add their own", () => {
		expect(nadUnitIdentifier({ Unit: "APT 6" })).toBe("6")
		expect(nadUnitIdentifier({ Unit: "UNIT D" })).toBe("D")
		expect(nadUnitIdentifier({ Unit: "RM 309-2" })).toBe("309-2")
	})

	it("keeps a bare identifier and strips a leading sigil", () => {
		expect(nadUnitIdentifier({ Unit: "200" })).toBe("200")
		expect(nadUnitIdentifier({ Unit: "# 4B" })).toBe("4B")
	})

	it("falls back to the room and reads an absent unit as empty", () => {
		expect(nadUnitIdentifier({ Room: "12" })).toBe("12")
		expect(nadUnitIdentifier({})).toBe("")
	})
})

describe("nadSkeletonRow", () => {
	it("projects a NAD record onto the OpenAddresses columns", () => {
		expect(nadSkeletonRow({ ...BASE, Unit: "APT 6" })).toEqual({
			NUMBER: "611",
			STREET: "EAST MAIN STREET",
			UNIT: "6",
			CITY: "Madison",
			DISTRICT: "Dane",
			REGION: "WI",
			POSTCODE: "53703",
			ID: "7fe2b28e-a357-41f5-be2b-27dfe65a2bf7",
		})
	})

	it("keeps the street's case when NAD publishes the name in mixed case", () => {
		expect(nadSkeletonRow({ ...BASE, St_Name: "Highland", St_PosTyp: "Boulevard" })?.STREET).toBe(
			"East Highland Boulevard"
		)
	})

	it("reads NAD's `Not stated` postal city as absent and takes the municipality", () => {
		expect(nadSkeletonRow({ ...BASE, Post_City: "Not stated", Inc_Muni: "Thompson" })?.CITY).toBe("Thompson")
	})

	it("reads an `Unincorporated` municipality as absent and takes the census place", () => {
		const record = { ...BASE, Post_City: "Not stated", Inc_Muni: "Unincorporated", Census_Plc: "Cypress" }

		expect(nadSkeletonRow(record)?.CITY).toBe("Cypress")
		expect(nadSkeletonRow({ ...record, Census_Plc: null })).toBeNull()
	})

	it("refuses a row without a five-digit ZIP, a locality or a house number", () => {
		expect(nadSkeletonRow({ ...BASE, Zip_Code: "5370" })).toBeNull()
		expect(nadSkeletonRow({ ...BASE, Post_City: null })).toBeNull()
		expect(nadSkeletonRow({ ...BASE, AddNo_Full: null })).toBeNull()
	})
})
