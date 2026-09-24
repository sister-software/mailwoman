/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate postcode-free French examples from BAN with separate street-prefix labels.
 */

import { FR_VOIE_TYPES } from "@mailwoman/codex/fr"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { decomposeFrStreet } from "#fr/adapters/ban/street-decompose"
import { alignAndWrite, readTuples, type CorpusRecipe, recipeSourceID } from "#recipes/scaffold"
import { SourceRegister } from "#registers"
import { SurfaceOrigin } from "#types"

/**
 * Shared provenance for postcode-free BAN rows.
 */
const FR_BARE_STREET_PROVENANCE = {
	register: SourceRegister.BaseAdresseNationale,
	surface: SurfaceOrigin.Composed,
}

/**
 * First abbreviation listed for each street type.
 */
const FR_VOIE_ABBREV: Record<string, string> = Object.fromEntries(
	Object.entries(FR_VOIE_TYPES).flatMap(([canonical, abbrevs]) => (abbrevs[0] ? [[canonical, abbrevs[0]]] : []))
)

/**
 * Index of the street-only form.
 */
const BARE_STREET_ONLY_FORM = 3

/**
 * Register the French bare-street recipe.
 */
export const frBareStreetRecipe: CorpusRecipe = {
	name: "fr-bare-street",
	description:
		"FR bare street+city, NO postcode (#251): comma / comma-free / abbreviated-voie surfaces over one label set",
	mode: "tuples",
	async run(opts, write) {
		// Preserve the recipe's seeded initialization.
		makeMulberry32(opts.seed)
		let read = 0
		let emitted = 0
		let skipped = 0

		for await (const t of readTuples(opts.input!)) {
			read++
			const fullStreet = String(t.street ?? "").trim()
			const number = String(t.number ?? "").trim()
			const locality = String(t.locality ?? "").trim()

			if (!fullStreet || !number || !locality) {
				skipped++

				continue
			}

			const { prefix, street } = decomposeFrStreet(fullStreet)

			// Retain some multiword streets without a recognized type as counterexamples.
			if (!prefix || !street) {
				if (read % 2 === 0 && fullStreet.split(" ").length >= 2) {
					const bare = {
						raw: fullStreet,
						components: { street: fullStreet } as Record<string, string>,
						country: "FR",
						locale: "fr-FR",
						source: "synth-fr-bare-street",
						source_id: recipeSourceID("synth-fr-bare-street", {
							street: fullStreet,
							f: "bare-nonvoie",
							v: String(read),
						}),
						corpus_version: "0.9.4",
						license:
							"Synthetic — fr-bare-street; (street, number, city) from BAN (Base Adresse Nationale, Licence Ouverte)",
					}

					if (alignAndWrite(write, bare, "fr-bare-street", FR_BARE_STREET_PROVENANCE)) {
						emitted++
					} else {
						skipped++
					}

					continue
				}

				skipped++

				continue
			}

			// Rotate comma-separated, compact, abbreviated, and street-only variants.
			const form = read % 4
			const prefixSurface = form >= 2 ? (FR_VOIE_ABBREV[prefix.toLowerCase()] ?? prefix) : prefix

			const components: Record<string, string> =
				form === BARE_STREET_ONLY_FORM
					? { street_prefix: prefix, street }
					: { house_number: number, street_prefix: prefixSurface, street, locality }

			// Include a neighborhood in the comma-separated form when available.
			const hood = String(t.neighbourhood ?? "").trim()

			if (form === 0 && hood) {
				components.dependent_locality = hood
			}

			const raw =
				form === 0
					? hood
						? `${number} ${prefix} ${street}, ${hood}, ${locality}`
						: `${number} ${prefix} ${street}, ${locality}`
					: form === BARE_STREET_ONLY_FORM
						? `${prefix} ${street}`
						: `${number} ${prefixSurface} ${street} ${locality}`

			const source_id = recipeSourceID("synth-fr-bare-street", { ...components, f: String(form), v: String(read) })

			const canonical = {
				raw,
				components,
				country: "FR",
				locale: "fr-FR",
				source: "synth-fr-bare-street",
				source_id,
				corpus_version: "0.9.4",
				license:
					"Synthetic — fr-bare-street; (street, number, city) from BAN (Base Adresse Nationale, Licence Ouverte)",
			}

			if (alignAndWrite(write, canonical, "fr-bare-street", FR_BARE_STREET_PROVENANCE)) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
