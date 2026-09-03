/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `fr-bare-street` slice recipe (#251) — the postcode-anchoring-imbalance change. BAN (and every
 *   other comprehensive FR source) is postcode-COMPLETE, so the model learned the French
 *   street→locality boundary as "the token after the 5-digit postcode," never as "comma + city." Strip
 *   the postcode and it leaks the street's proper-noun tokens into the following locality ("Rue René
 *   Cassin, Paris" → street="Rue Ren", locality="Cassin"). This recipe mints the MISSING distribution:
 *   the BARE comma form, NO postcode, real `(street, number, city)` tuples from BAN (Licence Ouverte —
 *   permissive; the model stays clean of ODbL, unlike the opt-in OSM rooftop slices).
 *
 *   Each tuple → `<n> <Rue/Avenue/…> <proper-noun name>, <City>` with the FR prefix split
 *   ({@link decomposeFrStreet}: "Rue" → street_prefix, the rest → street). Tuples whose street carries
 *   no recognized FR type word are skipped — the failing class is precisely the prefix-led street.
 *
 *   ⚠ Convention loss-mask: this recipe TEACHES FR `street_prefix`. The conventions loss-mask forbids it
 *   for FR and will `-inf` these gold labels (the v1.6.0 ~7M-loss blow-up). Disable that mask for any
 *   run including this slice.
 */

import { FR_VOIE_TYPES } from "@mailwoman/codex/fr"

import { decomposeFrStreet } from "#adapters/ban/street-decompose"
import { alignAndWrite, makeMulberry32, readTuples, type CorpusRecipe, sliceSourceID } from "#recipes/scaffold"

/**
 * Canonical voie type (lowercase, accent-kept) → its most common written abbreviation, from the codex table's first
 * entry. Types with no attested abbreviation stay canonical in the abbreviated form.
 */
const FR_VOIE_ABBREV: Record<string, string> = Object.fromEntries(
	Object.entries(FR_VOIE_TYPES).flatMap(([canonical, abbrevs]) => (abbrevs[0] ? [[canonical, abbrevs[0]]] : []))
)

/**
 * The order-cycle slot for the BARE-STREET-ONLY form (`«voie» «name»`, no number, no locality) — the absence
 * counterweight to the locality-terminated comma-free forms (see the cycle comment).
 */
const BARE_STREET_ONLY_FORM = 3

/**
 * Slice recipe registered with the corpus builder — see the file header for the parse behaviour it exists to exercise,
 * and `description` below for the surface form it generates.
 */
export const frBareStreetRecipe: CorpusRecipe = {
	name: "fr-bare-street",
	description:
		"FR bare street+city, NO postcode (#251): comma / comma-free / abbreviated-voie surfaces over one label set",
	mode: "tuples",
	async run(opts, write) {
		// Seeded for parity with the other recipes; unused beyond reproducibility (the tuples drive the content).
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

			// A no-prefix nom_voie ("La Ville Mois") is not the prefix-led class the numbered forms
			// exercise — but as a BARE surface it is exactly the non-voie-led counterweight the v4.5.1
			// probe showed missing ('Savile Row'-shaped spans still fell to the trailing-locality
			// prior; the voie-led bare form protected only voie-led spans). Alternate rows emit the
			// whole span as a bare street; the rest skip as before.
			if (!prefix || !street) {
				if (read % 2 === 0 && fullStreet.split(" ").length >= 2) {
					const bare = {
						raw: fullStreet,
						components: { street: fullStreet } as Record<string, string>,
						country: "FR",
						locale: "fr-FR",
						source: "synth-fr-bare-street",
						source_id: sliceSourceID("synth-fr-bare-street", {
							street: fullStreet,
							f: "bare-nonvoie",
							v: String(read),
						}),
						corpus_version: "0.9.4",
						license:
							"Synthetic — fr-bare-street; (street, number, city) from BAN (Base Adresse Nationale, Licence Ouverte)",
					}

					if (alignAndWrite(write, bare, "fr-bare-street")) {
						emitted++
					} else {
						skipped++
					}

					continue
				}

				skipped++

				continue
			}

			// Four surfaces over the same tuple, cycled deterministically. The comma form was the
			// original change; the COMMA-FREE form is the colloquial register users actually type
			// ('12 rue de Rome Paris' — the street↔locality boundary with NO delimiter, the fr-fr
			// panel's named loss); the ABBREVIATED form is the typeahead register the geocoder-tester
			// FR slice attests at scale; and the BARE-STREET-ONLY form is the absence counterweight —
			// without it, every delimiter-free surface in the mix ENDS in a locality, the model learns
			// "trailing span = locality" as categorical, and bare street names across locales flip to
			// locality wholesale (the v4.5.0 no-promote's measured erosion: 'Calle de Alcalá',
			// 'Madison Square West', and COMER's fork all fell to that prior). Tags are identical
			// where present; each component VALUE is the span as written (BIO alignment binds value
			// to surface); the bare form carries NO number and NO locality because the surface has
			// neither.
			const form = read % 4
			const prefixSurface = form >= 2 ? (FR_VOIE_ABBREV[prefix.toLowerCase()] ?? prefix) : prefix

			const components: Record<string, string> =
				form === BARE_STREET_ONLY_FORM
					? { street_prefix: prefix, street }
					: { house_number: number, street_prefix: prefixSurface, street, locality }

			// When the tuple carries a WOF-attested neighbourhood, the comma slot renders the
			// THREE-slot middle surface — the dependent-locality counterweight (the v4.5.1 erosion's
			// untouched half: the two-slot comma-free endings squeezed the middle tag out).
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

			const source_id = sliceSourceID("synth-fr-bare-street", { ...components, f: String(form), v: String(read) })

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

			if (alignAndWrite(write, canonical, "fr-bare-street")) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
