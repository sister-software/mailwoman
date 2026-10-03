/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { isPremiseDescriptor, isSamePlace, parseAcheminementLine, splitPostBox } from "#fr/adapters/finess/postal-lines"

describe("parseAcheminementLine", () => {
	it("splits the postcode from the routing locality", () => {
		expect(parseAcheminementLine("97100 BASSE TERRE")).toEqual({ postcode: "97100", locality: "BASSE TERRE" })
	})

	it("reads a trailing CEDEX with and without its office number", () => {
		expect(parseAcheminementLine("97306 CAYENNE CEDEX")).toEqual({
			postcode: "97306",
			locality: "CAYENNE",
			cedex: "CEDEX",
		})

		expect(parseAcheminementLine("97743 ST DENIS CEDEX 9")).toEqual({
			postcode: "97743",
			locality: "ST DENIS",
			cedex: "CEDEX 9",
		})
	})

	it("refuses a line that is not a routing line", () => {
		expect(parseAcheminementLine("")).toBeNull()
		expect(parseAcheminementLine("BASSE TERRE")).toBeNull()
		expect(parseAcheminementLine("97306 CEDEX")).toBeNull()
		expect(parseAcheminementLine("97306 CEDEX CAYENNE")).toBeNull()
	})
})

describe("splitPostBox", () => {
	it("takes the box out of a lieu-dit line and keeps the rest", () => {
		expect(splitPostBox("ZA ESPERANCE - BP 26")).toEqual({ poBox: "BP 26", remainder: "ZA ESPERANCE" })
		expect(splitPostBox("BP 381-SPRING CONCORDIA -")).toEqual({ poBox: "BP 381", remainder: "SPRING CONCORDIA" })
		expect(splitPostBox("SAVANNAH BP 90149")).toEqual({ poBox: "BP 90149", remainder: "SAVANNAH" })
		expect(splitPostBox("FAAA / BP 509")).toEqual({ poBox: "BP 509", remainder: "FAAA" })
	})

	it("reads La Poste's CS boxes and New Caledonia's lettered boxes", () => {
		expect(splitPostBox("CS 11021").poBox).toBe("CS 11021")
		expect(splitPostBox("RESIDENCE HALLEY - CS41105")).toEqual({ poBox: "CS41105", remainder: "RESIDENCE HALLEY" })
		expect(splitPostBox("BP M2").poBox).toBe("BP M2")
		expect(splitPostBox("PORTES DE FER / BP MGA 02")).toEqual({ poBox: "BP MGA 02", remainder: "PORTES DE FER" })
	})

	it("finds no box inside a word", () => {
		expect(splitPostBox("CASCADE")).toEqual({ poBox: null, remainder: "CASCADE" })
		expect(splitPostBox("ZAC 2000")).toEqual({ poBox: null, remainder: "ZAC 2000" })
	})
})

describe("isSamePlace", () => {
	it("folds case, accents, punctuation and the Saint abbreviation", () => {
		expect(isSamePlace("ST PIERRE", "Saint-Pierre")).toBe(true)
		expect(isSamePlace("STE CLOTILDE", "Sainte Clotilde")).toBe(true)
		expect(isSamePlace("MATA'UTU", "Mata Utu")).toBe(true)
		expect(isSamePlace("Rémire-Montjoly", "REMIRE MONTJOLY")).toBe(true)
	})

	it("tells different places apart and never matches an empty name", () => {
		expect(isSamePlace("ST PIERRE", "ST PAUL")).toBe(false)
		expect(isSamePlace("", "")).toBe(false)
	})
})

describe("isPremiseDescriptor", () => {
	it("recognizes a building, a floor, a corner or a school's grounds", () => {
		expect(isPremiseDescriptor("IMMEUBLE SEMAFA")).toBe(true)
		expect(isPremiseDescriptor("BAT SOUS MARQUE B - RDC")).toBe(true)
		expect(isPremiseDescriptor("ANGLE DES RUES JEAN JAURES")).toBe(true)
		expect(isPremiseDescriptor("ENCEINTE ECOLE DE TIAPA")).toBe(true)
		expect(isPremiseDescriptor("Lycée de Poindimié")).toBe(true)
	})

	it("leaves a place name and an estate alone", () => {
		expect(isPremiseDescriptor("MATA UTU")).toBe(false)
		expect(isPremiseDescriptor("LOTISSEMENT DILLON STADE")).toBe(false)
		expect(isPremiseDescriptor("RÉSIDENCE LES PALMISTES")).toBe(false)
		expect(isPremiseDescriptor("BATELIERE")).toBe(false)
	})
})
