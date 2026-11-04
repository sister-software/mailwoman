// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A US register's street line splits into a PO box, or a house number, street and unit, through the shared
 *   unit splitter reading USPS Publication 28's designators.
 */

import { describe, expect, it } from "vitest"

import { createUnitSplitter } from "#adapters/street/unit"
import { splitUSStreetLine, unitLine } from "#us/street-unit"

const units = await createUnitSplitter()

const kimball = await createUnitSplitter({
	streetIndex: (country) =>
		country === "US"
			? { countries: new Set(["US"]), hasStreetName: (street) => street.toLowerCase() === "n main" }
			: null,
})

const split = (street: string) => {
	const result = units.split(street, { country: "US" })

	return result && { street: result.street, unit: result.unit }
}

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
		expect(splitUSStreetLine("PO BOX 846", units)).toEqual({ po_box: "PO BOX 846" })
		expect(splitUSStreetLine(" P.O. Box 10240 ", units)).toEqual({ po_box: "P.O. Box 10240" })
		expect(splitUSStreetLine("P O BOX 190", units)).toEqual({ po_box: "P O BOX 190" })
	})

	it("keeps a street whose first word is Box", () => {
		expect(splitUSStreetLine("BOX ELDER RD", units)).toEqual({ street: "BOX ELDER RD" })
	})

	it("splits the house number and a trailing unit off a street line", () => {
		expect(splitUSStreetLine("2560 HUNTINGTON AVE STE 302", units)).toEqual({
			house_number: "2560",
			street: "HUNTINGTON AVE",
			unit: "STE 302",
		})

		expect(splitUSStreetLine("101 N Greenville Ave , Suite C", units)).toEqual({
			house_number: "101",
			street: "N Greenville Ave",
			unit: "Suite C",
		})

		expect(splitUSStreetLine("123 Main St", units)).toEqual({ house_number: "123", street: "Main St" })
		expect(splitUSStreetLine("  ", units)).toBeNull()
	})
})

describe("US street lines through the shared splitter", () => {
	it("splits a designator and its identifier off a street that ends in a street word or number", () => {
		expect(split("HUNTINGTON AVE STE 302")).toEqual({ street: "HUNTINGTON AVE", unit: "STE 302" })
		expect(split("MEDICAL PARK DR SUITE C")).toEqual({ street: "MEDICAL PARK DR", unit: "SUITE C" })
		expect(split("N ARKANSAS ST RM E3")).toEqual({ street: "N ARKANSAS ST", unit: "RM E3" })
		expect(split("US HIGHWAY 319N LOT 38")).toEqual({ street: "US HIGHWAY 319N", unit: "LOT 38" })
		expect(split("N WASHINGTON ST FL 2")).toEqual({ street: "N WASHINGTON ST", unit: "FL 2" })
	})

	it("splits a street without a street word only when the street index holds it", () => {
		// IMLS writes Kimball Public Library's line as `140 N MAIN SUITE 104`, with no street type.
		expect(split("N MAIN SUITE 104")).toBeNull()

		expect(kimball.split("N MAIN SUITE 104", { country: "US" })).toMatchObject({
			street: "N MAIN",
			unit: "SUITE 104",
			admittedBy: "attested",
		})

		expect(units.split("BOARDWALK APT. 914", { country: "US" })).toMatchObject({
			street: "BOARDWALK",
			admittedBy: "street-word",
		})
	})

	it("keeps the designator with a number-sign identifier", () => {
		expect(split("TUSKEGEE AIRMEN AVE BUILDING #500")).toEqual({
			street: "TUSKEGEE AIRMEN AVE",
			unit: "BUILDING #500",
		})

		expect(split("SOUTHWEST PKWY SUITE # 200")).toEqual({ street: "SOUTHWEST PKWY", unit: "SUITE # 200" })
		expect(split("SEMINARY RD #120")).toEqual({ street: "SEMINARY RD", unit: "#120" })
	})

	it("splits a number sign written apart from its identifier, the Publication 28 form", () => {
		expect(split("LAWRENCE EXPY # 190")).toEqual({ street: "LAWRENCE EXPY", unit: "# 190" })
		expect(split("PENNSYLVANIA AVE # A")).toEqual({ street: "PENNSYLVANIA AVE", unit: "# A" })
		expect(split("GROVEDALE CT, # 200")).toEqual({ street: "GROVEDALE CT", unit: "# 200" })
	})

	it("splits a designator joined to a numeric identifier", () => {
		expect(split("MAIN ST. RM203")).toEqual({ street: "MAIN ST.", unit: "RM203" })
		expect(split("HAYDEN RD SUITE26")).toEqual({ street: "HAYDEN RD", unit: "SUITE26" })
		expect(split("ROSS AVE. BLDG2 SUITE207B")).toEqual({ street: "ROSS AVE.", unit: "BLDG2 SUITE207B" })
		expect(split("PERRYSVILLE AVE FL2")).toEqual({ street: "PERRYSVILLE AVE", unit: "FL2" })
	})

	it("keeps a joined token whose letters are no designator, that opens the street, or that holds a ZIP Code", () => {
		expect(split("INTERSTATE I95")).toBeNull()
		expect(split("STE206")).toBeNull()
		expect(split("MAIN ST SUITEB")).toBeNull()
		expect(split("SW 92ND AVE BAY FL33157")).toBeNull()
	})

	it("splits two trailing units as one, in the order written", () => {
		expect(split("KING ST STE 300 BLDG 4")).toEqual({ street: "KING ST", unit: "STE 300 BLDG 4" })
	})

	it("drops the comma between the street and the unit", () => {
		expect(split("HINSON FARM ROAD, #504")).toEqual({ street: "HINSON FARM ROAD", unit: "#504" })
		expect(split("SIXTH STREET, SUITE #210")).toEqual({ street: "SIXTH STREET", unit: "SUITE #210" })
	})

	it("leaves a street whose designator word opens it or names it", () => {
		expect(split("SUITE B WESTGATE DRIVE")).toBeNull()
		expect(split("PIER 39")).toBeNull()
		expect(split("OLD FRONT ST")).toBeNull()
		expect(split("KEY WEST AVE")).toBeNull()
		expect(split("MAIN ST REAR")).toBeNull()
		expect(split("WILBARGER ST")).toBeNull()
	})
})
