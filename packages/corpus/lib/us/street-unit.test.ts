/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A trailing secondary unit on a US street line is split off, and street words that are designators are not.
 */

import { describe, expect, it } from "vitest"

import { splitTrailingUnit, splitUSStreetLine, unitLine } from "#us/street-unit"

describe("unitLine", () => {
	it("labels a designator or number-sign second line as the unit and leaves any other second line out", () => {
		expect(unitLine("SUITE 200")).toBe("SUITE 200")
		expect(unitLine("STE. 4")).toBe("STE. 4")
		expect(unitLine("Suite C, behind main building")).toBe("Suite C, behind main building")
		expect(unitLine(" APT 2B ")).toBe("APT 2B")
		expect(unitLine("#200")).toBe("#200")
		// Publication 28 lists DEPARTMENT among the secondary unit designators.
		expect(unitLine("DEPARTMENT OF SURGERY")).toBe("DEPARTMENT OF SURGERY")
		expect(unitLine("ATTN: BILLING")).toBeNull()
		expect(unitLine("C/O MERCY HOSPITAL")).toBeNull()
		expect(unitLine("MEDICAL OFFICE BUILDING")).toBeNull()
		expect(unitLine("")).toBeNull()
	})
})

describe("splitUSStreetLine", () => {
	it("labels a whole-line box with a numbered identifier as po_box", () => {
		expect(splitUSStreetLine("PO BOX 846")).toEqual({ po_box: "PO BOX 846" })
		expect(splitUSStreetLine(" P.O. Box 10240 ")).toEqual({ po_box: "P.O. Box 10240" })
		expect(splitUSStreetLine("P O BOX 190")).toEqual({ po_box: "P O BOX 190" })
	})

	it("keeps a street whose first word is Box", () => {
		expect(splitUSStreetLine("BOX ELDER RD")).toEqual({ street: "BOX ELDER RD" })
	})

	it("splits the house number and a trailing unit off a street line", () => {
		expect(splitUSStreetLine("2560 HUNTINGTON AVE STE 302")).toEqual({
			house_number: "2560",
			street: "HUNTINGTON AVE",
			unit: "STE 302",
		})

		expect(splitUSStreetLine("101 N Greenville Ave , Suite C")).toEqual({
			house_number: "101",
			street: "N Greenville Ave",
			unit: "Suite C",
		})

		expect(splitUSStreetLine("123 Main St")).toEqual({ house_number: "123", street: "Main St" })
		expect(splitUSStreetLine("  ")).toBeNull()
	})
})

describe("splitTrailingUnit", () => {
	it("splits a designator and its identifier off the end of the street", () => {
		expect(splitTrailingUnit("HUNTINGTON AVE STE 302")).toEqual({ street: "HUNTINGTON AVE", unit: "STE 302" })
		expect(splitTrailingUnit("BOARDWALK APT. 914")).toEqual({ street: "BOARDWALK", unit: "APT. 914" })
		expect(splitTrailingUnit("MEDICAL PARK DR SUITE C")).toEqual({ street: "MEDICAL PARK DR", unit: "SUITE C" })
		expect(splitTrailingUnit("N ARKANSAS ST RM E3")).toEqual({ street: "N ARKANSAS ST", unit: "RM E3" })
		expect(splitTrailingUnit("US HIGHWAY 319N LOT 38")).toEqual({ street: "US HIGHWAY 319N", unit: "LOT 38" })
		expect(splitTrailingUnit("N WASHINGTON ST FL 2")).toEqual({ street: "N WASHINGTON ST", unit: "FL 2" })
	})

	it("keeps the designator with a number-sign identifier", () => {
		expect(splitTrailingUnit("TUSKEGEE AIRMEN AVE BUILDING #500")).toEqual({
			street: "TUSKEGEE AIRMEN AVE",
			unit: "BUILDING #500",
		})

		expect(splitTrailingUnit("SOUTHWEST PKWY SUITE # 200")).toEqual({ street: "SOUTHWEST PKWY", unit: "SUITE # 200" })
		expect(splitTrailingUnit("SEMINARY RD #120")).toEqual({ street: "SEMINARY RD", unit: "#120" })
	})

	it("splits a number sign written apart from its identifier", () => {
		expect(splitTrailingUnit("LAWRENCE EXPY # 190")).toEqual({ street: "LAWRENCE EXPY", unit: "# 190" })
		expect(splitTrailingUnit("PENNSYLVANIA AVE # A")).toEqual({ street: "PENNSYLVANIA AVE", unit: "# A" })
		expect(splitTrailingUnit("GROVEDALE CT, # 200")).toEqual({ street: "GROVEDALE CT", unit: "# 200" })
	})

	it("splits a designator joined to a numeric identifier", () => {
		expect(splitTrailingUnit("MAIN ST. RM203")).toEqual({ street: "MAIN ST.", unit: "RM203" })
		expect(splitTrailingUnit("HAYDEN RD SUITE26")).toEqual({ street: "HAYDEN RD", unit: "SUITE26" })
		expect(splitTrailingUnit("ROSS AVE. BLDG2 SUITE207B")).toEqual({ street: "ROSS AVE.", unit: "BLDG2 SUITE207B" })
	})

	it("keeps a joined token whose letters are no designator, or that opens the street", () => {
		expect(splitTrailingUnit("INTERSTATE I95")).toBeNull()
		expect(splitTrailingUnit("STE206")).toBeNull()
		expect(splitTrailingUnit("MAIN ST SUITEB")).toBeNull()
		expect(splitTrailingUnit("SW 92ND AVE BAY FL33157")).toBeNull()
		expect(splitTrailingUnit("PERRYSVILLE AVE FL2")).toEqual({ street: "PERRYSVILLE AVE", unit: "FL2" })
	})

	it("splits two trailing units as one, in the order written", () => {
		expect(splitTrailingUnit("KING ST STE 300 BLDG 4")).toEqual({ street: "KING ST", unit: "STE 300 BLDG 4" })
	})

	it("drops the comma between the street and the unit", () => {
		expect(splitTrailingUnit("HINSON FARM ROAD, #504")).toEqual({ street: "HINSON FARM ROAD", unit: "#504" })
		expect(splitTrailingUnit("SIXTH STREET, SUITE #210")).toEqual({ street: "SIXTH STREET", unit: "SUITE #210" })
	})

	it("leaves a street whose designator word opens it or names it", () => {
		expect(splitTrailingUnit("SUITE B WESTGATE DRIVE")).toBeNull()
		expect(splitTrailingUnit("PIER 39")).toBeNull()
		expect(splitTrailingUnit("OLD FRONT ST")).toBeNull()
		expect(splitTrailingUnit("KEY WEST AVE")).toBeNull()
		expect(splitTrailingUnit("MAIN ST REAR")).toBeNull()
		expect(splitTrailingUnit("WILBARGER ST")).toBeNull()
	})
})
