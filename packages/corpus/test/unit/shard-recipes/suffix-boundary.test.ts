/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { classifySuffixBoundaryStreet } from "@mailwoman/corpus/shard-recipes/street-affix"
import { describe, expect, test } from "vitest"

describe("suffix-boundary #1569 source classifier", () => {
	test.each(["Blue Hill Rd", "Cedar Park Avenue", "Stone Ridge Dr", "Sutton Hollow Road"])(
		"keeps the ambiguous penultimate word inside the street name: %s",
		(street) => expect(classifySuffixBoundaryStreet(street)).toBe("terminal-only")
	)

	test.each(["Sutton Hollow", "Cedar Park", "Boston Common", "Willow Brook"])(
		"retains the same word as a suffix when it is terminal: %s",
		(street) => expect(classifySuffixBoundaryStreet(street)).toBe("terminal-contrast")
	)

	test.each(["Main Rd", "Amphitheatre Parkway", "Broadway", "North Main Street"])(
		"leaves streets outside the assay class alone: %s",
		(street) => expect(classifySuffixBoundaryStreet(street)).toBeNull()
	)
})

describe("suffix-boundary v2 layout shells (corpus 0.19.0)", () => {
	test("venue shell draws from the provided real-venue pool, not the six templates", async () => {
		const { renderRow } = await import("@mailwoman/corpus/shard-recipes/street-affix")

		const base = {
			house_number: "64",
			street: "Industrial Park Rd",
			locality: "Alburgh",
			region: "VT",
			postcode: "05440",
			base_source_id: "t",
		}

		const venues = ["Alburg Health Center", "White Bird Street Medicine"]
		// random() sequence: first call selects the shell (>=0.70 → venue), second picks the venue.
		const seq = [0.9, 0]
		let i = 0
		const random = () => seq[i++ % seq.length]!

		const row = renderRow(
			random,
			base,
			"Industrial Park Rd",
			{ street: "Industrial Park" },
			{
				venues,
				cuts: [0.35, 0.55, 0.7],
			}
		)

		expect(row.fmt).toBe("venue")
		expect(row.components.venue).toBe("Alburg Health Center")
		expect(row.raw.startsWith("Alburg Health Center, 64 Industrial Park Rd,")).toBe(true)
	})

	test("default options reproduce the original street-affix distribution", async () => {
		const { renderRow } = await import("@mailwoman/corpus/shard-recipes/street-affix")

		const base = {
			house_number: "12",
			street: "Main St",
			locality: "Ames",
			region: "IA",
			postcode: "50010",
			base_source_id: "t",
		}

		// r=0.5 under default cuts [0.4, 0.65, 0.85] → the bare shell, exactly as before.
		const row = renderRow(() => 0.5, base, "Main St", { street: "Main" })
		expect(row.fmt).toBe("bare")
		expect(row.raw).toBe("12 Main St")
	})
})
