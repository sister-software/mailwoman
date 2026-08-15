/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `bare-country` — the country name as the WHOLE query. Addresses almost never consist of one bare
 *   country name, so the class is out of the model's training distribution and the tag is a coin
 *   flip: measured on the 2026-08-13 panel, France/Germany/United States/New Zealand parsed
 *   `country` while Japan/China/Nigeria/Australia/Deutschland parsed `locality`. The retrieval-side
 *   bare-country race (#1651) covers the answer either way; this shard closes the PARSE half so the
 *   tag itself is right.
 *
 *   Source is the codex country table — every ISO canonical English name plus the curated surface
 *   forms (endonyms and long-form names). The 2–3 letter CODES are deliberately excluded: a bare
 *   `JP` or `GER` is an abbreviation register with its own ambiguity surface (`IN`, `DE`, `TO` are
 *   English words), and teaching it here would be an unmeasured claim. Case augmentation is the
 *   loader's job, as everywhere.
 */

import { COUNTRY_SURFACE_FORMS, CountryNames, matchCountry } from "@mailwoman/codex/country"

import { alignAndWrite, makeMulberry32, type ShardRecipe, shardSourceID } from "./scaffold.ts"

/**
 * Surfaces shorter than this are the code register (`JP`, `GER`), not a name — excluded (see the module doc).
 */
const MIN_NAME_LENGTH = 4

/**
 * Every (surface, iso2) pair the shard emits: the ISO canonical names plus each country's curated surface forms,
 * deduplicated on the surface string (a form shared across countries — none known — would keep its first bearer).
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
 * Shard recipe registered with the corpus builder — see the file header for the parse behaviour it exists to exercise,
 * and `description` below for the surface form it generates.
 */
export const bareCountryRecipe: ShardRecipe = {
	name: "bare-country",
	description: "The country name as the whole query (#1651 parse half): ISO names + curated endonyms, no codes",
	mode: "generate",
	async run(opts, write) {
		// Seeded for parity with the other recipes; the surfaces themselves drive the content.
		makeMulberry32(opts.seed)
		let read = 0
		let emitted = 0
		let skipped = 0

		for (const { surface, iso2 } of bareCountrySurfaces()) {
			read++

			const components: Record<string, string> = { country: surface }
			const source_id = shardSourceID("synth-bare-country", { country: surface, cc: iso2, v: String(read) })

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

			if (alignAndWrite(write, canonical, "bare-country")) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
