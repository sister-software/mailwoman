/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `po-box` — the two knobs that let one recipe emit a slice for one class.
 *
 *   The military rows (#517) are self-contained: they draw no tuple, so `--variants 0` with
 *   `--military-ratio 1` asks for them and nothing else. Both knobs had a defect measured on 2026-09-09 —
 *   `--variants 0` read as one through the CLI's `Number(x) || 1`, and `--source-name` was ignored — and
 *   together they produced a slice of 10,558 rows under the shipped label where 5,279 under its own were
 *   asked for. The tests below pin each.
 */

import { poBoxRecipe } from "@mailwoman/corpus/recipes/po/box/index"
import { sliceRunner } from "@mailwoman/corpus/test-kit/corpus-recipe"
import { describe, expect, it } from "vitest"

const run = sliceRunner("po-box", poBoxRecipe, 517)

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
		// Asserting an exact count here would be asserting the Spanish po-box template: these tuples name a country
		// the rendered line does not contain, so every tuple-driven row quarantines on `component-not-found:country`
		// and never reaches the slice. What the CLI defect destroyed is the DIFFERENCE between the two settings, and
		// that is what this pins — `Number("0") || 1` made the two indistinguishable.
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
	it("takes `--source-name`, so a military-only slice carries its own dose", async () => {
		// `synth-po-box` is absent from the shipped Latin config's mixture, so rows under that label are dropped at
		// load. A slice built for the #517 class needs a source of its own or it cannot be weighted at all.
		const { rows } = await run(TUPLES, [], { variants: 0, militaryRatio: 1, sourceName: "synth-po-box-military" })

		expect(rows.every((row) => row.source === "synth-po-box-military")).toBe(true)
		expect(rows.every((row) => row.source_id?.startsWith("synth-po-box-military"))).toBe(true)
	})

	it("keeps the shipped label when no name is given", async () => {
		const { rows } = await run(TUPLES, [], { variants: 0, militaryRatio: 1 })

		expect(rows.every((row) => row.source === "synth-po-box")).toBe(true)
	})
})
