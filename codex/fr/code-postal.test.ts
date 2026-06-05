/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import {
	departementForCodePostal,
	departementOfCodePostal,
	isCodePostal,
	normalizeCodePostal,
	regionForCodePostal,
} from "./code-postal.js"

describe("normalizeCodePostal", () => {
	it("strips an F- prefix and whitespace to the bare five digits", () => {
		expect(normalizeCodePostal("F-75008")).toBe("75008")
		expect(normalizeCodePostal(" 13001 ")).toBe("13001")
	})
	it("returns null for non-codes", () => {
		expect(normalizeCodePostal("7500")).toBeNull()
		expect(normalizeCodePostal("SW1A 1AA")).toBeNull()
		expect(normalizeCodePostal(75008)).toBeNull()
	})
})

describe("isCodePostal", () => {
	it("accepts five digits only", () => {
		expect(isCodePostal("75008")).toBe(true)
		expect(isCodePostal("7500")).toBe(false)
	})
})

describe("departementOfCodePostal — the clean first-two-digits rule", () => {
	it("maps a metropolitan code to its département by the first two digits", () => {
		expect(departementOfCodePostal("75008")).toBe("75") // Paris
		expect(departementOfCodePostal("13001")).toBe("13") // Bouches-du-Rhône
		expect(departementOfCodePostal("69002")).toBe("69") // Rhône
	})

	it("splits Corsica's shared 20 prefix into 2A / 2B", () => {
		expect(departementOfCodePostal("20000")).toBe("2A") // Ajaccio
		expect(departementOfCodePostal("20090")).toBe("2A")
		expect(departementOfCodePostal("20200")).toBe("2B") // Bastia
		expect(departementOfCodePostal("20600")).toBe("2B")
	})

	it("maps overseas DOM by their three-digit prefix", () => {
		expect(departementOfCodePostal("97110")).toBe("971") // Guadeloupe
		expect(departementOfCodePostal("97400")).toBe("974") // La Réunion
		expect(departementOfCodePostal("97600")).toBe("976") // Mayotte
	})

	it("returns null for a prefix with no département (collectivity / malformed)", () => {
		expect(departementOfCodePostal("97500")).toBeNull() // St-Pierre-et-Miquelon, not a DOM
		expect(departementOfCodePostal("98800")).toBeNull() // New Caledonia
		expect(departementOfCodePostal("nope")).toBeNull()
	})
})

describe("departementForCodePostal / regionForCodePostal — the postcode→admin chain", () => {
	it("resolves a code through to its département and région", () => {
		expect(departementForCodePostal("75008")?.name).toBe("Paris")
		expect(regionForCodePostal("75008")?.name).toBe("Île-de-France")
		expect(regionForCodePostal("13001")?.name).toBe("Provence-Alpes-Côte d'Azur")
		expect(regionForCodePostal("20000")?.name).toBe("Corse")
	})
})
