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
 *
 *   POSTCODE-PREFIXED FORMS (2026-08-20, #1748). The two bare forms above were the whole shard, and the
 *   board row this recipe was written for is NOT bare — it reads `…, 07691 Portopetro, Illes Balears,
 *   Spain`. Measured over both built shards: 88,904 rows, zero containing a postcode. So the model
 *   learned the bare tail correctly and had never once seen the shape it was failing on, which is why no
 *   decode lever moved it.
 *
 *   The collapse is two-staged and neither trigger is a street, which is what makes this cheap to teach:
 *
 *       Portopetro, Illes Balears, Spain             locality ✓  region ✓
 *       07691 Portopetro, Illes Balears, Spain       locality ✓  region DISCARDED
 *       15, 07691 Portopetro, Illes Balears, Spain   locality DISPLACED by the region
 *
 *   A postcode alone drops the region (every locale measured); a house number then displaces the
 *   locality. So the added surfaces are postcode-prefixed and house-number-plus-postcode-prefixed, and
 *   the shard still needs no street names.
 *
 *   The (postcode, locality, region) triples are REAL — `postalcode-intl.db` parents joined to admin
 *   localities and their region ancestors — with one filter that had to be measured rather than assumed.
 *   A handful of localities act as catch-all parents: `Schwedt/Oder` claims 9,222 postcodes, `Korb`
 *   4,846, against a p50 of 1 and a p99 of 53. Eight such hubs held 47% of the join. Capping at the p99
 *   drops them and keeps 17,908 triples. The house number is synthetic because a house number asserts no
 *   fact about a place; the postcode is not, because it does.
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
			const postcode = String(t.postcode ?? "").trim()

			// A tuple carrying a postcode emits the STRUCTURED tail — the shape the bare-only shard never
			// contained. Every fourth such row also carries a house number, which is the second trigger:
			// the postcode discards the region, the house number then displaces the locality.
			const withHouseNumber = postcode.length > 0 && read % 4 === 1
			const houseNumber = withHouseNumber ? String((read % 97) + 1) : ""

			const components: Record<string, string> = { locality, region }

			if (withCountry) {
				components["country"] = country
			}
			if (postcode) {
				components["postcode"] = postcode
			}
			if (withHouseNumber) {
				components["house_number"] = houseNumber
			}

			const tail = withCountry ? `${locality}, ${region}, ${country}` : `${locality}, ${region}`
			const head = withHouseNumber ? `${houseNumber}, ${postcode} ` : postcode ? `${postcode} ` : ""
			const raw = `${head}${tail}`
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
