/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `trailing-region` — the `«locality», «region»[, «country»]` admin tail, built from real
 *   `(locality, region)` WOF ancestor pairs.
 *
 *   A tuple's `postcodePlacement` selects where the postcode sits: `leading` (the default, so a
 *   tuples file written before the field existed is unchanged), `after_locality`, or `after_region`.
 *
 *   A bare `«region»` form is deliberately absent: teaching it as `region` would fight the
 *   locality/region ambiguity the dominance race arbitrates. A `dependentLocality`, when present,
 *   becomes `«dep_locality», «locality»…`; without it every row begins with the locality and teaches
 *   the model that the first named segment is the locality.
 */

import { lookupCanadianProvince } from "@mailwoman/codex/ca"
import { lookupUSState } from "@mailwoman/codex/us"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import {
	alignAndWrite,
	type PostcodePlacement,
	readTuples,
	requireRegister,
	type CorpusRecipe,
	recipeSourceID,
} from "#recipes/scaffold"
import { SurfaceOrigin } from "#types"

/**
 * The region code an address line in this country writes, or `null` where the region name is written out.
 *
 * A subdivision belongs here only when its code is a posted surface: Canadian province
 * and US state codes are, a Bundesland or a région is not.
 *
 * Several Canadian codes collide with ISO alpha-2 country codes (`NL`, `PE`),
 * so a code left unattested here reads as the country.
 */
function regionCodeSurface(cc: string, region: string): string | null {
	const country = cc.toUpperCase()

	if (country === "CA") return lookupCanadianProvince(region)

	return country === "US" ? lookupUSState(region) : null
}

/**
 * Recipe registered with the corpus builder.
 */
export const trailingRegionRecipe: CorpusRecipe = {
	name: "trailing-region",
	description: "Admin tails (Portopetro class): '«locality», «region»[, «country»]' from WOF ancestor pairs",
	mode: "tuples",
	async run(opts, write) {
		makeMulberry32(opts.seed)
		const structuredSource = opts.sourceName ?? "synth-trailing-region-structured"
		const bareSource = opts.sourceName ? `${opts.sourceName}-bare` : "synth-trailing-region"
		let read = 0
		let emitted = 0
		let skipped = 0

		const TRAILING_REGION_PROVENANCE = {
			register: requireRegister(opts, "trailing-region"),
			surface: SurfaceOrigin.Composed,
		}

		for await (const t of readTuples(opts.input!)) {
			read++
			const locality = String(t.locality ?? "").trim()
			const region = String(t.region ?? "").trim()
			const country = String(t.country ?? "").trim()
			const dependentLocality = String(t.dependentLocality ?? "").trim()

			// A pair whose region equals its locality carries no signal about the boundary this recipe teaches.
			if (!locality || !region || locality === region) {
				skipped++

				continue
			}

			const withCountry = read % 2 === 0 && country.length > 0
			const postcode = String(t.postcode ?? "").trim()

			// The house number is the second trigger: the postcode discards the region,
			// the house number then displaces the locality.
			const withHouseNumber = postcode.length > 0 && read % 4 === 1
			const houseNumber = withHouseNumber ? String((read % 97) + 1) : ""

			const components: Record<string, string> = { locality, region }

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
			const bareLocality = postcode && placement === "after_locality" ? `${locality} ${postcode}` : locality

			const localitySegment =
				components["dependent_locality"] === undefined ? bareLocality : `${dependentLocality}, ${bareLocality}`

			// The code alternates with the region name rather than replacing it:
			// both forms are posted and the resolver matches on the name.
			const regionCode = read % 3 === 2 ? regionCodeSurface(String(t.cc ?? ""), region) : null
			const regionSurface = regionCode ?? region

			if (regionCode) {
				components["region"] = regionCode
			}

			const regionSegment = postcode && placement === "after_region" ? `${regionSurface} ${postcode}` : regionSurface

			const tail = withCountry
				? `${localitySegment}, ${regionSegment}, ${country}`
				: `${localitySegment}, ${regionSegment}`

			const leadingPostcode = postcode && placement === "leading" ? `${postcode} ` : ""
			const head = withHouseNumber ? `${houseNumber}, ${leadingPostcode}` : leadingPostcode
			const raw = `${head}${tail}`
			// A distinct source for the structured rows: the sampler buckets by `source`,
			// so pooling them with the bare rows would make their weight unsettable.
			const sourceLabel = postcode ? structuredSource : bareSource
			const source_id = recipeSourceID(sourceLabel, { ...components, v: String(read) })

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

			if (alignAndWrite(write, canonical, "trailing-region", TRAILING_REGION_PROVENANCE)) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
