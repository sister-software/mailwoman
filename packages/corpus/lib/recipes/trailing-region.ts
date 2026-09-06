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
 *   POSTCODE-PREFIXED FORMS (2026-08-20, #1748). The two bare forms above were the whole slice, and the
 *   board row this recipe was written for is NOT bare — it reads `…, 07691 Portopetro, Illes Balears,
 *   Spain`. Measured over both built slices: 88,904 rows, zero containing a postcode. So the model
 *   learned the bare tail correctly and had never once seen the shape it was failing on, which is why no
 *   decode change moved it.
 *
 *   The collapse is two-staged and neither trigger is a street, which is what makes this cheap to teach:
 *
 *       Portopetro, Illes Balears, Spain             locality ✓  region ✓
 *       07691 Portopetro, Illes Balears, Spain       locality ✓  region DISCARDED
 *       15, 07691 Portopetro, Illes Balears, Spain   locality DISPLACED by the region
 *
 *   A postcode alone drops the region (every locale measured); a house number then displaces the
 *   locality. So the added surfaces are postcode-prefixed and house-number-plus-postcode-prefixed, and
 *   the slice still needs no street names.
 *
 *   POSTCODE PLACEMENT. The three surfaces above are the LEADING form, and for a long time they were the
 *   only one, so this slice taught only the countries that write the postcode first. That is a real gap
 *   and not a stylistic one, because the same digits change TAG with position. Measured on the shipped
 *   model: `Barcelona 6001, Anzoátegui, Venezuela` tags `6001` as `house_number` and loses the locality
 *   into the street, while `6001 Barcelona, Anzoátegui, Venezuela` tags it `postcode` and recovers
 *   `locality: Barcelona`. `Sandton 2196` vs `2196 Sandton` behaves the same way, and no decode-time
 *   change moves it — `postcodeShapeCoherence: true` leaves all eight VE board rows byte-identical.
 *
 *   So the tuple's `postcodePlacement` selects the surface, and it keeps apart two trailing conventions
 *   that are NOT the same shape: VE writes `Barcelona 6001, Anzoátegui, Venezuela` (the code on the
 *   LOCALITY segment) and IN writes `…, Bengaluru, Karnataka 560038, India` (on the REGION segment).
 *   Each of the three placements matches a board row verbatim. A tuple with no placement means `leading`,
 *   so a tuples file written before the field existed produces the rows it always did.
 *
 *   LEFT CONTEXT (v25). A tuple may carry a `dependentLocality`, and when it does the surface becomes
 *   `«dep_locality», «locality»…`. This is not decoration: without it EVERY row in the slice begins with
 *   the locality, and at a 9.4% share that taught the model the first named segment is the locality.
 *   Measured on the v4.8.0 candidate — `Ye Three Lords, 27 Minories, London EC3N 1DE` came back
 *   `locality: "Ye Three Lords"` with venue and street both gone, `Le Colimaçon, 44 Rue Vieille du
 *   Temple, 75004 Paris` came back `locality: "Le Colimaçon"`, and 11 of 25 regressions were venue-led
 *   rows across seven countries. The house-number prefix does NOT supply this: a number before the
 *   locality does not teach that a NAME can precede one. `no-fragment.ts`'s header records the same
 *   trap from the other direction.
 *
 *   The (postcode, locality, region) triples are REAL — `postalcode-intl.db` parents joined to admin
 *   localities and their region ancestors — with one filter that had to be measured rather than assumed.
 *   A handful of localities act as catch-all parents: `Schwedt/Oder` claims 9,222 postcodes, `Korb`
 *   4,846, against a p50 of 1 and a p99 of 53. Eight such hubs held 47% of the join. Capping at the p99
 *   drops them and keeps 17,908 triples. The house number is synthetic because a house number asserts no
 *   fact about a place; the postcode is not, because it does.
 */

import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { alignAndWrite, type PostcodePlacement, readTuples, type CorpusRecipe, sliceSourceID } from "#recipes/scaffold"

/**
 * Slice recipe registered with the corpus builder — see the file header for the parse behaviour it exists to exercise,
 * and `description` below for the surface form it generates.
 */
export const trailingRegionRecipe: CorpusRecipe = {
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
			const dependentLocality = String(t.dependentLocality ?? "").trim()

			// A pair whose region EQUALS its locality (Santa Cruz de Tenerife inside Santa Cruz de
			// Tenerife) teaches nothing about the boundary this slice exists for.
			if (!locality || !region || locality === region) {
				skipped++

				continue
			}

			const withCountry = read % 2 === 0 && country.length > 0
			const postcode = String(t.postcode ?? "").trim()

			// A tuple carrying a postcode emits the STRUCTURED tail — the shape the bare-only slice never
			// contained. Every fourth such row also carries a house number, which is the second trigger:
			// the postcode discards the region, the house number then displaces the locality.
			const withHouseNumber = postcode.length > 0 && read % 4 === 1
			const houseNumber = withHouseNumber ? String((read % 97) + 1) : ""

			const components: Record<string, string> = { locality, region }

			// LEFT CONTEXT. Without it every row begins with the locality, and the slice teaches that the first named
			// segment IS the locality — measured on the v4.8.0 candidate: `Ye Three Lords, 27 Minories, London EC3N 1DE`
			// came back `locality: "Ye Three Lords"` with the venue and street gone, and 11 of its 25 regressions were
			// venue-led rows across seven countries. The house-number prefix does not supply it, because a NUMBER before
			// the locality does not teach that a NAME can precede one.
			if (dependentLocality && dependentLocality !== locality) {
				components["dependent_locality"] = dependentLocality
			}

			if (withCountry) {
				components["country"] = country
			}

			if (postcode) {
				components["postcode"] = postcode
			}

			if (withHouseNumber) {
				components["house_number"] = houseNumber
			}

			const placement = (t.postcodePlacement as PostcodePlacement | undefined) ?? "leading"
			// Both trailing placements put the code inside the ADMIN tail; they differ in which segment carries it.
			const bareLocality = postcode && placement === "after_locality" ? `${locality} ${postcode}` : locality

			const localitySegment =
				components["dependent_locality"] === undefined ? bareLocality : `${dependentLocality}, ${bareLocality}`

			const regionSegment = postcode && placement === "after_region" ? `${region} ${postcode}` : region

			const tail = withCountry
				? `${localitySegment}, ${regionSegment}, ${country}`
				: `${localitySegment}, ${regionSegment}`

			// A leading postcode joins the head, ahead of the locality; the other two are already in the tail, so the
			// head carries at most the house number.
			const leadingPostcode = postcode && placement === "leading" ? `${postcode} ` : ""
			const head = withHouseNumber ? `${houseNumber}, ${leadingPostcode}` : leadingPostcode
			const raw = `${head}${tail}`
			// A DISTINCT source for the structured rows. The sampler buckets by `source` and weights each bucket,
			// so emitting these under `synth-trailing-region` would pool them with the 88,904 bare rows and make
			// the new surface unweightable — the dose would silently be whatever the bare slice's weight bought.
			const sourceLabel = postcode ? "synth-trailing-region-structured" : "synth-trailing-region"
			const source_id = sliceSourceID(sourceLabel, { ...components, v: String(read) })

			const canonical = {
				raw,
				components,
				country: String(t.cc ?? "").trim() || "und",
				locale: String(t.locale ?? "und"),
				source: sourceLabel,
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
