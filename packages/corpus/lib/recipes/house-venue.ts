/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `house-venue` slice recipe — synthetic house_number+venue+street co-occurrence rows: tuples →
 *   {@link synthesizeHouseVenueRow} → aligned LabeledRow. The v0.6.3 corrective companion to the
 *   no-street slice: every row carries BOTH house_number AND venue, restoring the house_number
 *   signal that no-street's distributional shift cost the model. Ported from
 *   scripts/build-house-venue-slice.mjs.
 */

import {
	alignAndWrite,
	makeLcg,
	readTuples,
	sliceSourceID,
	SYNTHETIC_TUPLE_LICENSE as LICENSE,
	type CorpusRecipe,
} from "#recipes/scaffold"
import { synthesizeHouseVenueRow, type HouseVenueBaseTuple } from "#synthesizers/house-venue"

/**
 * Slice recipe registered with the corpus builder — see the file header for the parse behaviour it exists to exercise,
 * and `description` below for the surface form it generates.
 */
export const houseVenueRecipe: CorpusRecipe = {
	name: "house-venue",
	description: "House_number+venue co-occurrence rows: tuples → synthesizeHouseVenueRow → aligned LabeledRow",
	mode: "tuples",
	async run(opts, write) {
		if (!opts.input) throw new Error("house-venue recipe requires --input <tuples.jsonl>")
		// Legacy build-house-venue-slice.mjs seeded the LCG via makeRandom(opts.seed) (s = seed).
		const random = makeLcg(opts.seed)
		const source = opts.sourceName ?? "synth-house-venue"
		let read = 0
		let emitted = 0
		let skipped = 0

		for await (const tuple of readTuples(opts.input)) {
			read++

			// FR renders without a region (postcode-before-locality tail — the run-2 contingency), so
			// an empty region is valid there and stays required everywhere else.
			if (!tuple.locality || !tuple.postcode || !tuple.country || (!tuple.region && tuple.country !== "FR")) {
				skipped++

				continue
			}

			for (let v = 0; v < opts.variants; v++) {
				const synth = synthesizeHouseVenueRow(tuple as HouseVenueBaseTuple, { random })

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
						source_id: sliceSourceID(source, {
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
					synth.template
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
