/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `no-street` recipe — synthetic no-street counter-example rows: tuples →
 *   {@link synthesizeNoStreetRow} → aligned LabeledRow. The corpus-side counterweight to the
 *   `invented-street` source — venue+admin and admin-only rows with explicit absence of any
 *   street-side component.
 */

import { makeLcg } from "@mailwoman/core/utils"

import {
	alignAndWrite,
	readTuples,
	recipeSourceID,
	SYNTHETIC_TUPLE_LICENSE as LICENSE,
	type CorpusRecipe,
} from "#recipes/scaffold"
import { defaultRecipeSource } from "#recipes/sources"
import { synthesizeNoStreetRow, type NoStreetBaseTuple } from "#synthesizers/no-street"
import { SurfaceOrigin } from "#types"

/**
 * A venue or admin-only row asserting that no street-side component is present.
 *
 * The row uses components from the `--input` tuples.
 * It teaches the absence of a street component instead of representing a source record.
 * No register asserts the row.
 */
const NO_STREET_PROVENANCE = {
	register: null,
	surface: SurfaceOrigin.Invented,
	// An invented row has no underlying record to name.
	baseSourceID: null,
}

/**
 * Recipe registered with the corpus builder.
 *
 * The file header describes the parse behavior this recipe exercises.
 * `description` below shows the generated surface form.
 */
export const noStreetRecipe: CorpusRecipe = {
	name: "no-street",
	description: "No-street counter-example rows: tuples → synthesizeNoStreetRow → aligned LabeledRow",
	mode: "tuples",
	async run(opts, write) {
		if (!opts.input) throw new Error("no-street recipe requires --input <tuples.jsonl>")
		// The legacy build script seeded the LCG via makeRandom(opts.seed) (s = seed).
		const random = makeLcg(opts.seed)
		const source = opts.sourceName ?? defaultRecipeSource("synth-no-street")
		let read = 0
		let emitted = 0
		let skipped = 0

		for await (const tuple of readTuples(opts.input)) {
			read++

			if (!tuple.locality || !tuple.region || !tuple.postcode || !tuple.country) {
				skipped++

				continue
			}

			for (let v = 0; v < opts.variants; v++) {
				const synth = synthesizeNoStreetRow(tuple as NoStreetBaseTuple, { random })

				if (!synth) {
					skipped++

					continue
				}

				const ok = alignAndWrite(
					write,
					{
						raw: synth.raw,
						components: synth.components,
						country: tuple.country,
						locale: synth.locale,
						source,
						source_id: recipeSourceID(source, {
							locality: tuple.locality,
							region: tuple.region,
							postcode: tuple.postcode,
							country: tuple.country,
							template: synth.template,
							v: String(v),
						}),
						corpus_version: "0.4.0",
						license: LICENSE,
					},
					synth.template,
					NO_STREET_PROVENANCE
				)

				if (ok) {
					emitted++
				} else {
					skipped++
				}
			}
		}

		return { read, emitted, skipped }
	},
}
