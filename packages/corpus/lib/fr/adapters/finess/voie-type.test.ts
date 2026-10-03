/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	expandFinessVoieType,
	isStreetNameDigitPlaced,
	splitFrenchStreetType,
	TRE_R35_VOIE_TYPES,
} from "#fr/adapters/finess/voie-type"

/**
 * Every `typvoie` code the overseas rows of the 2026-05-04 extract use, with TRE-R35's display for each.
 *
 * Read from the extract with the adapter's own reader over `departement` `9A`–`9F`
 * and `9J`, and from `CodeSystem-TRE-R35-TypeVoie.json` for the display.
 */
const OVERSEAS_CODES: Readonly<Record<string, string>> = {
	R: "rue",
	RTE: "route",
	AV: "avenue",
	CHE: "chemin",
	BD: "boulevard",
	LOT: "lotissement",
	QUA: "quartier",
	RES: "résidence",
	ALL: "allée",
	IMP: "impasse",
	PL: "place",
	ZAC: "ZAC",
	IMM: "immeuble",
	CCAL: "centre commercial",
	CITE: "cité",
	ZI: "ZI",
	VOI: "voie",
	RPT: "rond-point",
	BRG: "bourg",
	RLE: "ruelle",
	PARC: "parc",
	CTRE: "centre",
	ZA: "ZA",
	ESPA: "espace",
	CHEM: "cheminement",
	ZONE: "zone",
	VLA: "villa",
	ROC: "rocade",
	FG: "faubourg",
	CAR: "carrefour",
	VAL: "val",
	QU: "quai",
	PLAG: "plage",
	PAT: "patio",
	PAS: "passage",
	JARD: "jardin",
	CHS: "chaussée",
	ART: "ancienne route",
	ANSE: "anse",
}

describe("expandFinessVoieType", () => {
	it("resolves every code the overseas rows use", () => {
		for (const [code, word] of Object.entries(OVERSEAS_CODES)) {
			expect(expandFinessVoieType(code), code).toBe(word)
		}
	})

	it("reads LD as no word and an unknown code as unresolved", () => {
		expect(expandFinessVoieType("LD")).toBeNull()
		expect(expandFinessVoieType("")).toBeNull()
		expect(expandFinessVoieType("XYZ")).toBeUndefined()
	})

	it("follows TRE-R35 where the codex reads an abbreviation another way", () => {
		expect(TRE_R35_VOIE_TYPES["PASS"]).toBe("passe")
		expect(expandFinessVoieType("PASS")).toBe("passe")
	})
})

describe("isStreetNameDigitPlaced", () => {
	it("admits numbered routes and dates", () => {
		expect(isStreetNameDigitPlaced("NATIONALE 2")).toBe(true)
		expect(isStreetNameDigitPlaced("NATIONALE N 2")).toBe(true)
		expect(isStreetNameDigitPlaced("DEPARTEMENTAL 5")).toBe(true)
		expect(isStreetNameDigitPlaced("RN1")).toBe(true)
		expect(isStreetNameDigitPlaced("route Nationale 2")).toBe(true)
		expect(isStreetNameDigitPlaced("DU 22 MAI")).toBe(true)
		expect(isStreetNameDigitPlaced("DE PARIS")).toBe(true)
	})

	it("refuses a box, a building or a door left in the name", () => {
		expect(isStreetNameDigitPlaced("VALLÉE 3 BP 208")).toBe(false)
		expect(isStreetNameDigitPlaced("DIAKA BAT A4 PORTE 2")).toBe(false)
		expect(isStreetNameDigitPlaced("67")).toBe(false)
		expect(isStreetNameDigitPlaced("NATIONALE 4 BOURG")).toBe(false)
	})
})

describe("splitFrenchStreetType", () => {
	it("splits the leading type word from the name", () => {
		expect(splitFrenchStreetType("rue Maréchal Leclerc")).toEqual({ street_prefix: "rue", street: "Maréchal Leclerc" })
		expect(splitFrenchStreetType("Quartier EPINAY")).toEqual({ street_prefix: "Quartier", street: "EPINAY" })
		expect(splitFrenchStreetType("Lotissement Ondémia")).toEqual({ street_prefix: "Lotissement", street: "Ondémia" })
	})

	it("keeps a route number with its name rather than alone", () => {
		expect(splitFrenchStreetType("Route nationale 2")).toEqual({ street_prefix: "Route", street: "nationale 2" })
	})

	it("returns null for a line whose first word is no street type", () => {
		expect(splitFrenchStreetType("MATA UTU")).toBeNull()
	})
})
