/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import {
	isStreetDirectionalToken,
	lookupDirectional,
	lookupDirectionalAbbreviation,
	matchLeadingDirectional,
	pluckDirectionalName,
	renderDirectional,
} from "./street-directional.js"

test("pluckDirectionalName: abbreviation → full USPS name, case-insensitive", () => {
	expect(pluckDirectionalName("N")).toBe("NORTH")
	expect(pluckDirectionalName("ne")).toBe("NORTH EAST")
	expect(pluckDirectionalName(" sw ")).toBe("SOUTH WEST")
	expect(pluckDirectionalName("Main")).toBeNull()
	expect(pluckDirectionalName("")).toBeNull()
	expect(pluckDirectionalName(42)).toBeNull()
})

test("lookupDirectionalAbbreviation: name (any spacing/case) → abbreviation", () => {
	expect(lookupDirectionalAbbreviation("NORTH")).toBe("N")
	expect(lookupDirectionalAbbreviation("north east")).toBe("NE")
	expect(lookupDirectionalAbbreviation("Northeast")).toBe("NE") // unspaced one-word form
	expect(lookupDirectionalAbbreviation("South   West")).toBe("SW") // collapsed whitespace
	expect(lookupDirectionalAbbreviation("Main")).toBeNull()
})

test("lookupDirectional: resolves abbreviation OR name to both forms", () => {
	expect(lookupDirectional("N")).toEqual({ directional: "NORTH", abbreviation: "N" })
	expect(lookupDirectional("northeast")).toEqual({ directional: "NORTH EAST", abbreviation: "NE" })
	expect(lookupDirectional("SOUTH WEST")).toEqual({ directional: "SOUTH WEST", abbreviation: "SW" })
	expect(lookupDirectional("Main")).toBeNull()
})

test("matchLeadingDirectional: matches the first word only, preserving its surface", () => {
	expect(matchLeadingDirectional("N Main St")).toEqual({ canonical: "NORTH", abbreviation: "N", matched: "N" })
	expect(matchLeadingDirectional("Northeast Blvd")).toEqual({
		canonical: "NORTH EAST",
		abbreviation: "NE",
		matched: "Northeast",
	})
	// a street whose first word is not a directional
	expect(matchLeadingDirectional("Main St")).toBeNull()
	// directional NOT at the start is not a leading match
	expect(matchLeadingDirectional("Old North Rd")).toBeNull()
	expect(matchLeadingDirectional("   ")).toBeNull()
})

test("renderDirectional: emits abbr/full in the reference's case", () => {
	const ne = { canonical: "NORTH EAST", abbreviation: "NE" } as const
	expect(renderDirectional(ne, "abbr", "N").toUpperCase()).toBe("NE")
	// the "full" form is the one-word US street spelling, not the spaced publication form
	expect(renderDirectional(ne, "full", "Main")).toBe("Northeast")
	const n = { canonical: "NORTH", abbreviation: "N" } as const
	expect(renderDirectional(n, "abbr", "s")).toBe("n") // lower-case reference → lower-case output
})

test("isStreetDirectionalToken: true for any directional surface, false otherwise", () => {
	for (const tok of ["N", "n", "NW", "north", "South East", "southwest"]) {
		expect(isStreetDirectionalToken(tok)).toBe(true)
	}

	for (const tok of ["Main", "Street", "", 7, null]) {
		expect(isStreetDirectionalToken(tok)).toBe(false)
	}
})
