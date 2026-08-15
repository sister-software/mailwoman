/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `trailing-region` — the `«locality», «region», «country»` admin tail, the Portopetro class
 *   (board row `es-op3-southeast-portopetro`): `…, 07691 Portopetro, Illes Balears, Spain` parsed
 *   with the REGION mislabeled `locality` and the true locality dropped entirely. Spanish sources
 *   are postcode-complete and rarely write the region, so the trailing-region segment is
 *   under-attested and the model reads the last populous name as the locality.
 *
 *   Tuples are real `(locality, region)` ancestor pairs from the WOF admin DB (the fr-hood-pairs
 *   extraction shape). Two surface forms per pair — with and without the trailing country — so the
 *   region is attested both as the middle and the final segment. A bare `«region»` form is
 *   deliberately absent: that surface is the bare-toponym class with its own rules, and teaching it
 *   here as `region` would fight the locality/region ambiguity the dominance race arbitrates.
 *
 *   The recipe is country-agnostic; the country tail surface comes from the tuple's `country`
 *   field ("Spain", "United Kingdom") so one recipe serves every extraction.
 */

import { alignAndWrite, makeMulberry32, readTuples, type ShardRecipe, shardSourceID } from "./scaffold.ts"

/**
 * Shard recipe registered with the corpus builder — see the file header for the parse behaviour it exists to exercise,
 * and `description` below for the surface form it generates.
 */
export const trailingRegionRecipe: ShardRecipe = {
	name: "trailing-region",
	description: "Admin tails (Portopetro class): '«locality», «region»[, «country»]' from WOF ancestor pairs",
	mode: "tuples",
	async run(opts, write) {
		makeMulberry32(opts.seed)
		let read = 0
		let emitted = 0
		let skipped = 0

		for await (const t of readTuples(opts.input!)) {
			read++
			const locality = String(t.locality ?? "").trim()
			const region = String(t.region ?? "").trim()
			const country = String(t.country ?? "").trim()

			// A pair whose region EQUALS its locality (Santa Cruz de Tenerife inside Santa Cruz de
			// Tenerife) teaches nothing about the boundary this shard exists for.
			if (!locality || !region || locality === region) {
				skipped++

				continue
			}

			const withCountry = read % 2 === 0 && country.length > 0

			const components: Record<string, string> = withCountry ? { locality, region, country } : { locality, region }

			const raw = withCountry ? `${locality}, ${region}, ${country}` : `${locality}, ${region}`
			const source_id = shardSourceID("synth-trailing-region", { ...components, v: String(read) })

			const canonical = {
				raw,
				components,
				country: String(t.cc ?? "").trim() || "und",
				locale: String(t.locale ?? "und"),
				source: "synth-trailing-region",
				source_id,
				corpus_version: "0.11.0",
				license: "Synthetic — trailing-region; (locality, region) ancestor pairs from WOF (CC0/ODC-By per source)",
			}

			if (alignAndWrite(write, canonical, "trailing-region")) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
