/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate parse examples from codex country names and curated variants. Exclude short codes because they are
 *   ambiguous with abbreviations and words.
 */

import { COUNTRY_SURFACE_FORMS, CountryNames, matchCountry } from "@mailwoman/codex/country"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { alignAndWrite, type CorpusRecipe, recipeSourceID } from "#recipes/scaffold"
import { SourceRegister } from "#registers"
import { SurfaceOrigin } from "#types"

/**
 * Provenance for standalone country names.
 */
const BARE_COUNTRY_PROVENANCE = {
	register: SourceRegister.Codex,
	surface: SurfaceOrigin.Attested,
}

/**
 * Minimum country-name length; shorter forms are ambiguous codes.
 */
const MIN_NAME_LENGTH = 4

/**
 * Yield unique canonical and curated country names.
 */
function* bareCountrySurfaces(): Generator<{ surface: string; iso2: string }> {
	const seen = new Set<string>()

	for (const [iso2, forms] of Object.entries(COUNTRY_SURFACE_FORMS)) {
		for (const surface of forms) {
			if (surface.length < MIN_NAME_LENGTH || seen.has(surface)) continue
			seen.add(surface)
			yield { surface, iso2 }
		}
	}

	for (const name of CountryNames) {
		if (name.length < MIN_NAME_LENGTH || seen.has(name)) continue
		const matched = matchCountry(name)

		if (!matched) continue
		seen.add(name)
		yield { surface: name, iso2: matched.iso2 }
	}
}

/**
 * Bare-country recipe.
 */
export const bareCountryRecipe: CorpusRecipe = {
	name: "bare-country",
	description: "The country name as the whole query (#1651 parse half): ISO names + curated endonyms, no codes",
	mode: "generate",
	async run(opts, write) {
		// Preserve the common recipe seed interface.
		makeMulberry32(opts.seed)
		let read = 0
		let emitted = 0
		let skipped = 0

		for (const { surface, iso2 } of bareCountrySurfaces()) {
			read++

			const components: Record<string, string> = { country: surface }
			const source_id = recipeSourceID("synth-bare-country", { country: surface, cc: iso2, v: String(read) })

			const canonical = {
				raw: surface,
				components,
				country: iso2,
				locale: "und",
				source: "synth-bare-country",
				source_id,
				corpus_version: "0.11.0",
				license: "Synthetic — bare-country; surfaces from the codex country table (ISO 3166 + curated forms)",
			}

			if (alignAndWrite(write, canonical, "bare-country", BARE_COUNTRY_PROVENANCE)) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
