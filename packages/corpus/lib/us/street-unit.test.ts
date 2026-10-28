/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A trailing secondary unit on a US street line is split off, and street words that are designators are not.
 */

import { describe, expect, it } from "vitest"

import { splitTrailingUnit } from "#us/street-unit"

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
