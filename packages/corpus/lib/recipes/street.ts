/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `street` recipe — synthetic street-decomposition rows for Stage 3 (US-only): tuples →
 *   {@link synthesizeStreetRow} → aligned LabeledRow. Ported from the root build script it replaced.
 */

import { makeLcg } from "@mailwoman/core/utils"

import { stableSourceID } from "#adapters/source-id"
import { alignAndWrite, readTuples, type CorpusRecipe } from "#recipes/scaffold"
import { defaultRecipeSource } from "#recipes/sources"
import { SurfaceOrigin } from "#types"
import { synthesizeStreetRow, type StreetBaseTuple } from "#us/synthesizers/street"

/**
 * The recipe draws a street name from a pool and joins it to a tuple's locality, region and postcode.
 *
 * No register asserts that the street runs through that locality.
 * The row is invented rather than a rendering of a published record.
 */
/**
 * Resolved once, because `source_id` includes the source as its prefix and a pair
 * that disagreed would name a source no row of this output declares.
 */
const STREET_SOURCE = defaultRecipeSource("synth-street")

const STREET_PROVENANCE = {
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
export const streetRecipe: CorpusRecipe = {
	name: "street",
	description: "Street-decomposition rows (US): tuples → synthesizeStreetRow → aligned LabeledRow",
	mode: "tuples",
	options: [{ flag: "--house-number-prob <p>", description: "P(emit a house number). Default 0.85" }],
	async run(opts, write) {
		if (!opts.input) throw new Error("street recipe requires --input <tuples.jsonl>")
		const random = makeLcg(opts.seed)
		const includeHouseNumberProb = opts.houseNumberProb ?? 0.85
		let read = 0
		let emitted = 0
		let skipped = 0

		for await (const tuple of readTuples(opts.input)) {
			read++

			if (!tuple.locality || !tuple.region || !tuple.postcode || !tuple.country) {
				skipped++

				continue
			}

			// country-branch: `synthesizeStreetRow` renders the US layout only.
			// The codex layouts in the `locale` recipe cover the rest.
			if (tuple.country !== "US") {
				skipped++

				continue
			}

			for (let v = 0; v < opts.variants; v++) {
				const synth = synthesizeStreetRow(tuple as StreetBaseTuple, { random, includeHouseNumberProb })

				if (!synth) continue

				const ok = alignAndWrite(
					write,
					{
						raw: synth.raw,
						components: synth.components,
						country: tuple.country,
						locale: synth.locale,
						source: STREET_SOURCE,
						source_id: stableSourceID(STREET_SOURCE, {
							locality: `${tuple.locality}#${v}`,
							region: tuple.region,
							postcode: tuple.postcode,
							country: tuple.country,
						}),
						corpus_version: "0.4.0",
						license: "Synthetic — public-domain street name + tuple combination",
					},
					"street-decomp",
					STREET_PROVENANCE
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
