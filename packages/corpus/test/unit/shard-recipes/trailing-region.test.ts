/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `trailing-region` — POSTCODE PLACEMENT, the surface that decides which countries this shard can teach.
 *
 *   The same digits change TAG with position. Measured on the shipped model, `Barcelona 6001, Anzoátegui, Venezuela`
 *   tags `6001` as `house_number` and loses the locality into the street, while `6001 Barcelona, Anzoátegui, Venezuela`
 *   tags it `postcode` and recovers `locality: Barcelona`. So a shard emitting one placement teaches one family of
 *   countries, and the tests below pin which surface each placement writes — including that an ABSENT placement still
 *   means `leading`, because a tuples file written before the field existed must produce the rows it always did.
 */

import { trailingRegionRecipe } from "@mailwoman/corpus/shard-recipes/trailing-region"
import { describe, expect, it } from "vitest"

import { shardRunner } from "#test-kit/shard-recipe"

const run = shardRunner("trailing-region", trailingRegionRecipe, 901)

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
		// new surface share the bare shard's dose and become unweightable.
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
		// The bare admin tail is the shard's original surface and the placements must not touch it.
		for (const placement of ["leading", "after_locality", "after_region"] as const) {
			const { rows } = await run(repeat({ ...base, postcodePlacement: placement }), [])

			expect(rows.every((row) => /^Portopetro, Illes Balears(, Spain)?$/.test(row.raw))).toBe(true)
		}
	})
})
