/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `po-box` — the two knobs that let one recipe emit an output for one class; the military rows
 *   are self-contained and draw no tuple, so `--variants 0` with `--military-ratio 1` asks for them
 *   and no other variant.
 */

import { poBoxRecipe } from "@mailwoman/corpus/recipes/po/box/index"
import { recipeRunner } from "@mailwoman/corpus/test-kit/corpus-recipe"
import { describe, expect, it } from "vitest"

const run = recipeRunner("po-box", poBoxRecipe, 517)

/**
 * Tuples in the shape the recipe requires: a locality, a postcode, a country, and a region (except NZ).
 */
const TUPLES = Array.from({ length: 6 }, (_, index) => ({
	locality: "Madrid",
	region: "Comunidad de Madrid",
	postcode: `2800${index}`,
	country: "Spain",
	cc: "ES",
	locale: "es-ES",
}))

/**
 * The military line the gold convention tags whole as `po_box`, with APO/FPO/DPO as the locality.
 */
const MILITARY = /^(PSC|CMR|Unit) \d+( Box \d+)?, (APO|FPO|DPO) (AA|AE|AP) \d{5}$/u

describe("po-box military rows", () => {
	it("emits ONLY the military rows at variants 0, one per input line", async () => {
		const { rows } = await run(TUPLES, [], { variants: 0, militaryRatio: 1 })

		expect(rows).toHaveLength(TUPLES.length)

		for (const row of rows) {
			expect(row.raw).toMatch(MILITARY)
			expect(row.components?.po_box).toBeTruthy()
		}
	})

	it("writes strictly more at variants 1 than at variants 0 — the discriminator the CLI defect erased", async () => {
		// An exact count here would assert the Spanish po-box template: these tuples name a country
		// the rendered line omits, so every tuple-driven row quarantines on `component-not-found:country`.
		const zero = await run(TUPLES, [], { variants: 0, militaryRatio: 1 })
		const one = await run(TUPLES, [], { variants: 1, militaryRatio: 1 })

		expect(one.rows.length).toBeGreaterThan(zero.rows.length)
	})

	it("emits no military row when the ratio is left at zero", async () => {
		const { rows } = await run(TUPLES, [], { variants: 0 })

		expect(rows).toHaveLength(0)
	})
})

describe("po-box source labelling", () => {
	it("takes `--source-name`, so a military-only output carries its own reps per row", async () => {
		// `synth-po-box` is absent from the shipped Latin config's mixture, so rows under that label are
		// dropped at load and an output with its own class needs a source of its own to be weighted at all.
		const { rows } = await run(TUPLES, [], { variants: 0, militaryRatio: 1, sourceName: "synth-po-box-military" })

		expect(rows.every((row) => row.source === "synth-po-box-military")).toBe(true)
		expect(rows.every((row) => row.source_id?.startsWith("synth-po-box-military"))).toBe(true)
	})

	it("keeps the shipped label when no name is given", async () => {
		const { rows } = await run(TUPLES, [], { variants: 0, militaryRatio: 1 })

		expect(rows.every((row) => row.source === "synth-po-box")).toBe(true)
	})
})
