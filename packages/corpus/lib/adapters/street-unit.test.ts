/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { splitCountryTrailingUnit } from "#adapters/street-unit"

describe("splitCountryTrailingUnit", () => {
	it("splits a premise or floor designator and its identifier off the end, in the row's country's words", () => {
		expect(splitCountryTrailingUnit("du General Charles de Gaulle Bat B", "FR")).toEqual({
			street: "du General Charles de Gaulle",
			unit: "Bat B",
		})

		expect(splitCountryTrailingUnit("Avenue Des Massettes Batiment F", "FR")).toEqual({
			street: "Avenue Des Massettes",
			unit: "Batiment F",
		})

		expect(splitCountryTrailingUnit("de la Maladiere Entree 20C", "FR")).toEqual({
			street: "de la Maladiere",
			unit: "Entree 20C",
		})

		expect(splitCountryTrailingUnit("VIA REGINA MARGHERITA SCALA C", "IT")).toEqual({
			street: "VIA REGINA MARGHERITA",
			unit: "SCALA C",
		})

		expect(splitCountryTrailingUnit("PLAZA DE ESPANA S/N PLANTA B", "ES")).toEqual({
			street: "PLAZA DE ESPANA S/N",
			unit: "PLANTA B",
		})
	})

	it("keeps a street whose last words are no designator and identifier", () => {
		expect(splitCountryTrailingUnit("des Choucas des Tours", "FR")).toBeNull()
		expect(splitCountryTrailingUnit("Casanova d’Aracciani Residence Mare E Piana", "FR")).toBeNull()
		expect(splitCountryTrailingUnit("Bat B", "FR")).toBeNull()
		expect(splitCountryTrailingUnit("Chemin de la Tour D", "FR")).toBeNull()
	})

	it("drops a dash between the street and the unit", () => {
		expect(splitCountryTrailingUnit("Résidence Montrozier - Appartement 7", "FR")).toEqual({
			street: "Résidence Montrozier",
			unit: "Appartement 7",
		})
	})

	it("matches a two-letter designator only in capitals, so a lower-case conjunction stays in the street", () => {
		expect(splitCountryTrailingUnit("rue victor Schoelcher Bat E et F", "FR")).toBeNull()
		expect(splitCountryTrailingUnit("RUE DE LA PAIX ET 3", "FR")).toEqual({ street: "RUE DE LA PAIX", unit: "ET 3" })
	})

	it("reads another country's words only for that country", () => {
		expect(splitCountryTrailingUnit("VIA REGINA MARGHERITA SCALA C", "FR")).toBeNull()
	})

	it("returns null for a country without a designator table", () => {
		expect(splitCountryTrailingUnit("Rue Principale Bat B", "ZZ")).toBeNull()
	})
})
