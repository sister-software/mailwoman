/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Tests for the `no-street-led` recipe's board split.
 *
 * The recipe must not train on its own eval set. The diacritic split is the invariant that
 * matters. The Norwegian digit board keeps diacritics in its surface key (`tømmerlien`) while
 * fr-fragment's normalizer strips them. The `fr-fragment` `norm` function would fold `Tømmerlien` to
 * `tommerlien`, never match the reserved `tømmerlien`, and leak the surface into training while
 * every check reported success. `tømmerlien` therefore gets a test with a diacritic surface.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { noStreetLedRecipe } from "@mailwoman/corpus/no/recipes/street/led"
import { scratch, recipeRunner } from "@mailwoman/corpus/test-kit/corpus-recipe"
import { describe, expect, it } from "vitest"

const run = recipeRunner("no-street-led", noStreetLedRecipe, 901)

const TUPLES = [
	{ street: "Tømmerlien", locality: "dokka", number: "3", postcode: "2870" },
	{ street: "Hallingrudveien", locality: "vikersund", number: "32", postcode: "3370" },
	{ street: "Øvrabø", locality: "hellvik", number: "124/1", postcode: "4375" },
]

describe("no-street-led board split", () => {
	it("REFUSES to run without an exclusion list", async () => {
		await using inputs = await scratch("no-street-led", TUPLES, [])

		await expect(
			noStreetLedRecipe.run({ output: "", seed: 901, variants: 1, input: inputs.input }, () => {})
		).rejects.toThrow(/--exclude-surfaces is REQUIRED/)
	})

	it("REFUSES an exclusion list that resolves to zero surfaces", async () => {
		await using inputs = await scratch("no-street-led", TUPLES, [])
		await writeLocalTextFile("# only a comment\n", inputs.exclude)

		await expect(
			noStreetLedRecipe.run(
				{ output: "", seed: 901, variants: 1, input: inputs.input, excludeSurfaces: inputs.exclude },
				() => {}
			)
		).rejects.toThrow(/listed no surfaces/)
	})

	it("emits every surface when none are reserved", async () => {
		const { stats } = await run(TUPLES, ["some-other-street"])

		expect(stats.contaminated).toBe(0)
		expect(stats.emitted).toBeGreaterThan(0)
	})

	it("skips a reserved surface — KEEPING diacritics (the whole hazard)", async () => {
		const { stats, rows } = await run(TUPLES, ["tømmerlien"])

		expect(stats.contaminated).toBe(1)

		for (const row of rows) {
			expect(row.raw.toLowerCase()).not.toContain("tømmerlien")
		}
	})

	it("does NOT skip when the reserved surface differs only by a stripped diacritic", async () => {
		const { stats } = await run(TUPLES, ["tommerlien"])

		expect(stats.contaminated).toBe(0)
	})
})
