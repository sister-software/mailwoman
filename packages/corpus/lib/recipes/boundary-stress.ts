/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `boundary-stress` recipe, the boundary-instability augmentation. Self-generates `--count` rows
 *   from {@link synthesizeBoundaryStressRow}'s weighted template mix. It aligns each to BIO and emits a
 *   labeled jsonl.
 *
 *   `synthesizeBoundaryStressRow` is imported directly here.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { type CorpusRecipe, recipeSourceID } from "#recipes/scaffold"
import { defaultRecipeSource } from "#recipes/sources"
import { type BoundaryStressTemplate, synthesizeBoundaryStressRow } from "#synthesizers/boundary-stress"
import { SurfaceOrigin } from "#types"
import { alignRow } from "#utils"

/**
 * Template weights, in the order the cumulative thresholds below read.
 *
 * The mix keeps `bare-locality` near 11%, so bare "City, state" rows are well
 * represented without a locality-first majority.
 * House-number-before and house-number-after render at 7:3.
 *
 * This breaks the order-bias shortcut while keeping FR house-number-before accuracy.
 *
 * Weights sum to 1.0.
 * The key order drives the cumulative thresholds below.
 */
const WEIGHTS: Record<BoundaryStressTemplate, number> = {
	"street-eats-affix": 0.22,
	"comma-less-city-state": 0.22,
	"fr-prefix": 0.18,
	"bare-locality": 0.11,
	"house-number-before-street": 0.189,
	"house-number-after-street": 0.081,
}

const CUM: Array<[BoundaryStressTemplate, number]> = (() => {
	let acc = 0

	return (Object.entries(WEIGHTS) as Array<[BoundaryStressTemplate, number]>).map(
		([t, w]) => [t, (acc += w)] as [BoundaryStressTemplate, number]
	)
})()

function pickTemplate(r: () => number): BoundaryStressTemplate {
	const x = r()

	for (const [t, c] of CUM) if (x <= c) return t

	return CUM.at(-1)![0]
}

/**
 * Recipe registered with the corpus builder.
 *
 * See the file header for the parse behaviour this recipe exercises
 * and `description` below for the surface form it generates.
 */
export const boundaryStressRecipe: CorpusRecipe = {
	name: "boundary-stress",
	description: "Boundary-instability rows (#375): weighted template mix → synthesizeBoundaryStressRow → aligned BIO",
	mode: "generate",
	async run(opts, write) {
		const random = makeMulberry32(opts.seed)
		const count = opts.count ?? 20_000
		let emitted = 0
		let skipped = 0

		for (let i = 0; i < count; i++) {
			const row = synthesizeBoundaryStressRow(undefined, { random, forceTemplate: pickTemplate(random) })
			const country = row.locale.split("-")[1] ?? "US"
			// One resolution for both, because `source_id` carries the source as its prefix
			// and a pair that disagreed would name a source no row of this output declares.
			const source = defaultRecipeSource("synth-boundary-stress")
			const source_id = recipeSourceID(source, { ...row.components, v: String(i) })

			const canonical = {
				raw: row.raw,
				components: row.components,
				country,
				locale: row.locale,
				source,
				source_id,
				corpus_version: "0.6.0",
				license: "Synthetic — boundary-stress; derived from public-domain locality/region tuples",
			}

			const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])

			if (aligned.kind !== "labeled") {
				skipped++

				continue
			}

			// Match the base corpus parquet schema: flat columns rather than a nested object.
			write(
				stringifyJSON({
					...aligned.row,
					recipe: `boundary-stress:${row.template}`,
					base_source_id: null,
					// Every component is drawn from a template mix built to sit on a tag boundary.
					register: null,
					surface: SurfaceOrigin.Invented,
				})
			)

			emitted++
		}

		return { emitted, skipped }
	},
}
