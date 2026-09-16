/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `trailing-region` — POSTCODE PLACEMENT, the surface that decides which countries this recipe can teach.
 *
 *   The same digits change TAG with position. Measured on the shipped model, `Barcelona 6001, Anzoátegui, Venezuela`
 *   tags `6001` as `house_number` and loses the locality into the street, while `6001 Barcelona, Anzoátegui, Venezuela`
 *   tags it `postcode` and recovers `locality: Barcelona`. So a recipe emitting one placement teaches one family of
 *   countries, and the tests below pin which surface each placement writes — including that an ABSENT placement still
 *   means `leading`, because a tuples file written before the field existed must produce the rows it always did.
 */

import { CA_PROVINCES } from "@mailwoman/codex/ca"
import { trailingRegionRecipe } from "@mailwoman/corpus/recipes/trailing-region"
import { recipeRunner } from "@mailwoman/corpus/test-kit/corpus-recipe"
import { describe, expect, it } from "vitest"

const run = recipeRunner("trailing-region", trailingRegionRecipe, 901)

/**
 * One tuple repeated with each placement. Same locality, region, country and code throughout, so any difference in the
 * emitted `raw` is the placement and nothing else.
 */
const base = { locality: "Portopetro", region: "Illes Balears", country: "Spain", cc: "ES", locale: "es-ES" }

/**
 * The recipe varies its surfaces by row INDEX (`read % 2`, `read % 4`), so a single tuple cannot exercise a given
 * placement's plain form reliably. Repeating it lets the assertions look for a surface among the emitted rows rather
 * than pinning one index.
 */
const repeat = (tuple: object, n = 8): object[] => Array.from({ length: n }, () => ({ ...tuple }))

describe("trailing-region postcode placement", () => {
	it("puts the postcode BEFORE the locality by default — the FR/DE/ES/IT convention", async () => {
		const { rows } = await run(repeat({ ...base, postcode: "07691", postcodePlacement: "leading" }), [])

		expect(rows.some((row) => row.raw === "07691 Portopetro, Illes Balears, Spain")).toBe(true)
		expect(rows.some((row) => row.raw.includes("Portopetro 07691"))).toBe(false)
	})

	it("treats an ABSENT placement as leading, so an old tuples file is unchanged", async () => {
		const withField = await run(repeat({ ...base, postcode: "07691", postcodePlacement: "leading" }), [])
		const without = await run(repeat({ ...base, postcode: "07691" }), [])

		// Byte-identical, not merely equivalent: the 17,908-row tuples file on disk carries no placement.
		expect(without.rows.map((row) => row.raw)).toEqual(withField.rows.map((row) => row.raw))
	})

	it("writes the VE shape — postcode in the locality's own segment, AHEAD of the region", async () => {
		const tuple = { locality: "Barcelona", region: "Anzoátegui", country: "Venezuela", cc: "VE", locale: "es-VE" }
		const { rows } = await run(repeat({ ...tuple, postcode: "6001", postcodePlacement: "after_locality" }), [])

		expect(rows.some((row) => row.raw === "Barcelona 6001, Anzoátegui, Venezuela")).toBe(true)
		// The failing board rows are exactly this string; a leading code here would teach the wrong country.
		expect(rows.some((row) => row.raw.startsWith("6001 "))).toBe(false)
	})

	it("writes the IN shape — postcode on the REGION segment, ahead of the country", async () => {
		const tuple = { locality: "Bengaluru", region: "Karnataka", country: "India", cc: "IN", locale: "en-IN" }
		const { rows } = await run(repeat({ ...tuple, postcode: "560038", postcodePlacement: "after_region" }), [])

		expect(rows.some((row) => row.raw === "Bengaluru, Karnataka 560038, India")).toBe(true)
		// The `in_structured` board row reads exactly this. A code on the locality segment would be VE's shape.
		expect(rows.some((row) => row.raw.includes("Bengaluru 560038"))).toBe(false)
	})

	it("still labels every postcode-carrying row as the STRUCTURED source, whatever the placement", async () => {
		// The sampler weights by `source`. A placement that leaked rows back into `synth-trailing-region` would make the
		// new surface share the bare source's reps per row and become unweightable.
		const { rows } = await run(
			[
				{ ...base, postcode: "07691", postcodePlacement: "leading" },
				{ ...base, postcode: "6001", postcodePlacement: "after_locality" },
				{ ...base, postcode: "560038", postcodePlacement: "after_region" },
			],
			[]
		)

		expect(rows.every((row) => row.source === "synth-trailing-region-structured")).toBe(true)
	})

	it("leaves a tuple with no postcode alone under every placement", async () => {
		// The bare admin tail is the recipe's original surface and the placements must not touch it.
		for (const placement of ["leading", "after_locality", "after_region"] as const) {
			const { rows } = await run(repeat({ ...base, postcodePlacement: placement }), [])

			expect(rows.every((row) => /^Portopetro, Illes Balears(, Spain)?$/.test(row.raw))).toBe(true)
		}
	})
})

describe("trailing-region Canadian province codes", () => {
	const ca = (region: string) => ({
		locality: "Gander",
		region,
		country: "Canada",
		cc: "CA",
		locale: "en-CA",
		postcode: "A1V 0A9",
		postcodePlacement: "after_region",
	})

	it("writes the province code beside the name form, never instead of it", async () => {
		const { rows } = await run(repeat(ca("Newfoundland and Labrador"), 12), [])

		expect(rows.some((row) => row.raw.includes("Gander, NL A1V 0A9, Canada"))).toBe(true)
		expect(rows.some((row) => row.raw.includes("Newfoundland and Labrador"))).toBe(true)
	})

	it("labels the region component as the surface the row wrote", async () => {
		const { rows } = await run(repeat(ca("Newfoundland and Labrador"), 12), [])
		const coded = rows.filter((row) => row.raw.includes(", NL A1V 0A9"))

		expect(coded.length).toBeGreaterThan(0)
		expect(coded.every((row) => row.components?.["region"] === "NL")).toBe(true)
	})

	it("covers every province and territory", async () => {
		for (const { code, name } of Object.values(CA_PROVINCES)) {
			const { rows } = await run(repeat(ca(name), 12), [])

			expect(rows.some((row) => row.raw.includes(`, ${code} A1V 0A9`))).toBe(true)
		}
	})

	it("reaches the same code from the co-official French name", async () => {
		for (const { code, french } of Object.values(CA_PROVINCES)) {
			const { rows } = await run(repeat(ca(french), 12), [])

			expect(rows.some((row) => row.raw.includes(`, ${code} A1V 0A9`))).toBe(true)
		}
	})

	it("leaves a country that writes its region out alone", async () => {
		const { rows } = await run(repeat({ ...base, postcode: "07691", postcodePlacement: "after_region" }, 12), [])

		expect(rows.every((row) => row.raw.includes("Illes Balears"))).toBe(true)
	})

	it("writes the US state code too, which is the surface #2303 measured missing", async () => {
		// The code reaches the model in volume through the US sources, but only ever with a STREET in front of the city.
		// This recipe's `after_region` surface is the bare one: `Washington, DC 20003`.
		const us = (region: string) => ({
			locality: "Washington",
			region,
			country: "United States",
			cc: "US",
			locale: "en-US",
			postcode: "20003",
			postcodePlacement: "after_region",
		})

		const { rows } = await run(repeat(us("District of Columbia"), 12), [])
		const coded = rows.filter((row) => row.raw.includes(", DC 20003"))

		expect(coded.length).toBeGreaterThan(0)
		expect(coded.every((row) => row.components?.["region"] === "DC")).toBe(true)
		// Both forms are posted for the US, so the name keeps its share rather than being replaced.
		expect(rows.some((row) => row.raw.includes("District of Columbia"))).toBe(true)
	})
})

describe("trailing-region source labelling", () => {
	it("takes `--source-name`, so a rebuilt output can be weighted apart from the rows it must outweigh", async () => {
		// The sampler buckets by `source` and weights each bucket. #1673's corrected Spanish surfaces are the same
		// recipe over the same shape as the rows they exist to outweigh, so emitting them under the shipped label
		// would have given them exactly the reps per row those rows already draw — no treatment at all.
		const tuples = repeat({ ...base, postcode: "07691", postcodePlacement: "leading" })
		const { rows } = await run(tuples, [], { sourceName: "synth-trailing-region-es-v28" })

		expect(rows.every((row) => row.source === "synth-trailing-region-es-v28")).toBe(true)
	})

	it("keeps the structured and bare rows apart under an overridden name too", async () => {
		// The split exists because pooling the structured rows with the 88,904 bare ones makes the new surface
		// unweightable; an override that collapsed the two would reintroduce that under the renamed source.
		const { rows } = await run(repeat({ ...base }), [], { sourceName: "synth-trailing-region-es-v28" })

		expect(rows.every((row) => row.source === "synth-trailing-region-es-v28-bare")).toBe(true)
	})

	it("keeps the shipped labels when no name is given", async () => {
		const structured = await run(repeat({ ...base, postcode: "07691", postcodePlacement: "leading" }), [])
		const bare = await run(repeat({ ...base }), [])

		expect(structured.rows.every((row) => row.source === "synth-trailing-region-structured")).toBe(true)
		expect(bare.rows.every((row) => row.source === "synth-trailing-region")).toBe(true)
	})
})
