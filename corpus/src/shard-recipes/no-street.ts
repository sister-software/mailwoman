/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `no-street` shard recipe — synthetic NO-street counter-example rows: tuples →
 *   {@link synthesizeNoStreetRow} → aligned LabeledRow. The corpus-side counterweight to the
 *   synth-street shard that drove v0.6.1's `dependent_locality` regression — venue+admin and
 *   admin-only rows with explicit absence of any street-side component. Ported from
 *   scripts/build-no-street-shard.mjs.
 */

import { synthesizeNoStreetRow, type NoStreetBaseTuple } from "../synthesize-no-street.js"
import { alignAndWrite, makeLcg, readTuples, shardSourceId, type ShardRecipe } from "./scaffold.js"

const LICENSE = "Synthetic — derived from CC-BY / public-domain input tuples"

export const noStreetRecipe: ShardRecipe = {
	name: "no-street",
	description: "No-street counter-example rows: tuples → synthesizeNoStreetRow → aligned LabeledRow",
	mode: "tuples",
	async run(opts, write) {
		if (!opts.input) throw new Error("no-street recipe requires --input <tuples.jsonl>")
		// Legacy build-no-street-shard.mjs seeded the LCG via makeRandom(opts.seed) (s = seed).
		const random = makeLcg(opts.seed)
		const source = opts.sourceName ?? "synth-no-street"
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
						source_id: shardSourceId(source, {
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
				if (ok) emitted++
				else skipped++
			}
		}
		return { read, emitted, skipped }
	},
}
