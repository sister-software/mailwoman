import { COUNTRY_SURFACE_FORMS, CountryNames, matchCountry } from "@mailwoman/codex/country"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { alignAndWrite, type CorpusRecipe, recipeSourceID } from "#recipes/scaffold"
import { SourceRegister } from "#registers"
import { SurfaceOrigin } from "#types"

const BARE_COUNTRY_PROVENANCE = {
	register: SourceRegister.Codex,
	surface: SurfaceOrigin.Attested,
}

const MIN_NAME_LENGTH = 4

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
 * Generates queries that consist of a country name alone, drawn from ISO names
 * and curated surface forms of at least four characters, with no country codes.
 */
export const bareCountryRecipe: CorpusRecipe = {
	name: "bare-country",
	description: "The country name as the whole query (#1651 parse half): ISO names + curated endonyms, no codes",
	mode: "generate",
	async run(opts, write) {
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
