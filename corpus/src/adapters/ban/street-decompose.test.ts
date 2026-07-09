/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { decomposeFrStreet } from "./street-decompose.ts"

describe("decomposeFrStreet", () => {
	it("single-word street type prefix", () => {
		expect(decomposeFrStreet("Rue de Rivoli")).toEqual({ prefix: "Rue", street: "de Rivoli" })
		expect(decomposeFrStreet("Avenue des Champs-Élysées")).toEqual({
			prefix: "Avenue",
			street: "des Champs-Élysées",
		})
		expect(decomposeFrStreet("Boulevard Voltaire")).toEqual({ prefix: "Boulevard", street: "Voltaire" })
	})

	it("abbreviation prefix", () => {
		// 'bd' and 'av' are common abbreviations in libpostal/fr
		expect(decomposeFrStreet("Bd Voltaire")).toEqual({ prefix: "Bd", street: "Voltaire" })
		expect(decomposeFrStreet("Av Foch")).toEqual({ prefix: "Av", street: "Foch" })
	})

	it("two-word prefix (ancien chemin)", () => {
		expect(decomposeFrStreet("Ancien Chemin de Lyon")).toEqual({
			prefix: "Ancien Chemin",
			street: "de Lyon",
		})
	})

	it("no decomposition — unknown leading word", () => {
		expect(decomposeFrStreet("Saint-Just-Saint-Rambert")).toEqual({
			prefix: null,
			street: "Saint-Just-Saint-Rambert",
		})
	})

	it("no decomposition — single token", () => {
		expect(decomposeFrStreet("Rivoli")).toEqual({ prefix: null, street: "Rivoli" })
	})

	it("empty input", () => {
		expect(decomposeFrStreet("")).toEqual({ prefix: null, street: "" })
		expect(decomposeFrStreet("   ")).toEqual({ prefix: null, street: "" })
	})
})
