/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `street` shard recipe — synthetic street-decomposition rows for Stage 3 (US-only): tuples →
 *   {@link synthesizeStreetRow} → aligned LabeledRow. Ported from scripts/build-street-shard.mjs.
 */

import { stableSourceID } from "../adapter.js"
import { synthesizeStreetRow, type StreetBaseTuple } from "../synthesize-street.js"
import { alignAndWrite, makeLcg, readTuples, type ShardRecipe } from "./scaffold.js"

export const streetRecipe: ShardRecipe = {
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
						source: "synth-street",
						source_id: stableSourceID("synth-street", {
							locality: `${tuple.locality}#${v}`,
							region: tuple.region,
							postcode: tuple.postcode,
							country: tuple.country,
						}),
						corpus_version: "0.4.0",
						license: "Synthetic — public-domain street name + tuple combination",
					},
					"street-decomp"
				)

				if (ok) emitted++
				else skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
