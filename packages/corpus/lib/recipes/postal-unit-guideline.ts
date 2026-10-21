/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `postal-unit-guideline` recipe: rows that write a flat, unit, floor, staircase or building
 *   designator as the postal operator's published guideline states it. It runs the `postal-guideline`
 *   generator over unit legs, so every row goes through the aligner and takes the split its place
 *   gives it.
 *
 *   The rows get their own source, `invented-postal-unit-guideline`, rather than the PO-box rows'
 *   `invented-postal-guideline`: a release capability selects rows by source, so a separate source
 *   keeps `po_box_cedex` and `postal_unit` from reading each other's rows.
 *
 *   Six countries have a cited unit table in the codex. Five of them have a leg: FR, GB, IT, AU and
 *   NZ. US has none, because every Pub 28 Appendix C2 designator is one `spliced-unit` or
 *   `synthetic-secondary` writes in training. DE has none, because the Deutsche Post page states no
 *   unit rule.
 */

import { stringifyJSON } from "@mailwoman/core/json"

import { AU_UNIT_TYPE_GUIDELINE_LEG } from "#au/recipes/unit-type-guideline"
import { FR_UNIT_LINE_GUIDELINE_LEG } from "#fr/recipes/unit-line-guideline"
import { GB_SUB_BUILDING_GUIDELINE_LEG } from "#gb/recipes/sub-building-guideline"
import { IT_UNIT_LINE_GUIDELINE_LEG } from "#it/recipes/unit-line-guideline"
import { NZ_UNIT_TYPE_GUIDELINE_LEG } from "#nz/recipes/unit-type-guideline"
import {
	generatePostalGuidelineRows,
	POSTAL_GUIDELINE_DEFAULT_COUNT,
	readPostalGuidelinePlaces,
} from "#recipes/postal-guideline"
import type { PostalGuidelineLeg, PostalGuidelinePlace } from "#recipes/postal-guideline/leg"
import type { CorpusRecipe } from "#recipes/scaffold"
import { defaultRecipeSource } from "#recipes/sources"

/**
 * The unit legs the recipe runs, one per country.
 */
export const POSTAL_UNIT_GUIDELINE_LEGS: readonly PostalGuidelineLeg[] = [
	FR_UNIT_LINE_GUIDELINE_LEG,
	GB_SUB_BUILDING_GUIDELINE_LEG,
	IT_UNIT_LINE_GUIDELINE_LEG,
	AU_UNIT_TYPE_GUIDELINE_LEG,
	NZ_UNIT_TYPE_GUIDELINE_LEG,
]

/**
 * The registered recipe.
 */
export const postalUnitGuidelineRecipe: CorpusRecipe = {
	name: "postal-unit-guideline",
	description:
		"Unit rows (FR line 2/3 designators, GB Flat, IT scala/piano/interno, AU and NZ unit types) " +
		"from cited operator guidelines, on GeoNames places; each row takes its place's split",
	mode: "generate",
	options: [{ flag: "--count", description: "Rows per country leg (default 2000)" }],
	async run(opts, write) {
		const places = new Map<string, readonly PostalGuidelinePlace[]>()

		for (const leg of POSTAL_UNIT_GUIDELINE_LEGS) {
			const read = await readPostalGuidelinePlaces(leg)

			console.error(`  ${leg.country}: ${read.length} GeoNames postal places`)

			places.set(leg.country, read)
		}

		const rows = generatePostalGuidelineRows({
			places,
			legs: POSTAL_UNIT_GUIDELINE_LEGS,
			count: opts.count ?? POSTAL_GUIDELINE_DEFAULT_COUNT,
			seed: opts.seed,
			source: opts.sourceName ?? defaultRecipeSource("synth-postal-unit-guideline"),
		})

		for (const row of rows) {
			write(stringifyJSON(row))
		}

		return { emitted: rows.length, skipped: 0 }
	},
}
