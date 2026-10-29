/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file France's house-venue tuples: French title case and the reserved board surfaces.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { describe, expect, it } from "vitest"

import { frenchTitleCase, frReservedSurfacesPath, readFRReservedSurfaces } from "#fr/recipes/house-venue-tuples"

describe("frenchTitleCase", () => {
	it("keeps particles lower case after the first word and capitalizes after an elision", () => {
		expect(frenchTitleCase("rue de la paix")).toBe("Rue de la Paix")
		expect(frenchTitleCase("de la gare")).toBe("De la Gare")
		expect(frenchTitleCase("place d'armes")).toBe("Place d'Armes")
		expect(frenchTitleCase("saint-jean-de-luz")).toBe("Saint-Jean-De-Luz")
		expect(frenchTitleCase("  rue   mendes   france ")).toBe("Rue Mendes France")
	})
})

describe("readFRReservedSurfaces", () => {
	it("reads the committed board list", async () => {
		const reserved = await readFRReservedSurfaces()

		expect(reserved.has("allee alberte bonjean")).toBe(true)
		expect(frReservedSurfacesPath().toString()).toMatch(/ban-fragments-fr\.surfaces\.txt$/)
	})

	it("names the path of a missing list rather than reserving nothing", async () => {
		await using scratch = await temporaryDirectory("mailwoman-fr-tuples-")
		const path = scratch.path("absent.txt").toString()

		await expect(readFRReservedSurfaces(path)).rejects.toThrow(path)
	})
})
