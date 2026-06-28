/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { departementInfo, FR_DEPARTEMENTS } from "./departement.js"

test("departementInfo: metropolitan code → name + région", () => {
	expect(departementInfo("13")).toEqual({ code: "13", name: "Bouches-du-Rhône", region: "PAC" })
	expect(departementInfo("75")).toEqual({ code: "75", name: "Paris", region: "IDF" })
	expect(departementInfo("01")).toEqual({ code: "01", name: "Ain", region: "ARA" })
	expect(departementInfo("69")).toEqual({ code: "69", name: "Rhône", region: "ARA" })
})

test("departementInfo: overseas (DOM) three-digit code → name + région", () => {
	expect(departementInfo("971")).toEqual({ code: "971", name: "Guadeloupe", region: "GUA" })
	expect(departementInfo("974")).toEqual({ code: "974", name: "La Réunion", region: "LRE" })
	expect(departementInfo("976")).toEqual({ code: "976", name: "Mayotte", region: "MAY" })
})

test("departementInfo: Corsica letter codes are case-insensitive", () => {
	expect(departementInfo("2A")).toEqual({ code: "2A", name: "Corse-du-Sud", region: "COR" })
	expect(departementInfo("2B")).toEqual({ code: "2B", name: "Haute-Corse", region: "COR" })
	// the docstring promises case-insensitivity for the Corsica letters
	expect(departementInfo("2a")).toEqual({ code: "2A", name: "Corse-du-Sud", region: "COR" })
	expect(departementInfo("2b")).toEqual({ code: "2B", name: "Haute-Corse", region: "COR" })
})

test("departementInfo: trims surrounding whitespace", () => {
	expect(departementInfo("  13  ")).toEqual({ code: "13", name: "Bouches-du-Rhône", region: "PAC" })
	expect(departementInfo("\t2a\n")).toEqual({ code: "2A", name: "Corse-du-Sud", region: "COR" })
})

test("departementInfo: unknown / malformed / non-string → null", () => {
	// 20 was split into 2A/2B and is no longer a valid département code
	expect(departementInfo("20")).toBeNull()
	// 96 is unassigned; 975/977/978 overseas collectivities are not DOM and not in the table
	expect(departementInfo("96")).toBeNull()
	expect(departementInfo("975")).toBeNull()
	expect(departementInfo("00")).toBeNull()
	expect(departementInfo("999")).toBeNull()
	expect(departementInfo("Ain")).toBeNull() // name is not a key
	expect(departementInfo("")).toBeNull()
	expect(departementInfo(null)).toBeNull()
	expect(departementInfo(undefined)).toBeNull()
	expect(departementInfo(13 as unknown as string)).toBeNull()
})

test("FR_DEPARTEMENTS: each record's code field equals its own key (no transcription drift)", () => {
	for (const [key, info] of Object.entries(FR_DEPARTEMENTS)) {
		expect(info.code).toBe(key)
	}
})

test("FR_DEPARTEMENTS: holds exactly 101 départements (96 metropolitan incl. 2A/2B + 5 DOM)", () => {
	expect(Object.keys(FR_DEPARTEMENTS)).toHaveLength(101)
})
