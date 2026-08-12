/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `fr-bare-street` shard recipe (#251) — the postcode-anchoring-imbalance lever. BAN (and every
 *   other comprehensive FR source) is postcode-COMPLETE, so the model learned the French
 *   street→locality boundary as "the token after the 5-digit postcode," never as "comma + city." Strip
 *   the postcode and it leaks the street's proper-noun tokens into the following locality ("Rue René
 *   Cassin, Paris" → street="Rue Ren", locality="Cassin"). This recipe mints the MISSING distribution:
 *   the BARE comma form, NO postcode, real `(street, number, city)` tuples from BAN (Licence Ouverte —
 *   permissive; the model stays clean of ODbL, unlike the opt-in OSM rooftop shards).
 *
 *   Each tuple → `<n> <Rue/Avenue/…> <proper-noun name>, <City>` with the FR prefix split
 *   ({@link decomposeFrStreet}: "Rue" → street_prefix, the rest → street). Tuples whose street carries
 *   no recognized FR type word are skipped — the failing class is precisely the prefix-led street.
 *
 *   ⚠ Convention loss-mask: this recipe TEACHES FR `street_prefix`. The conventions loss-mask forbids it
 *   for FR and will `-inf` these gold labels (the v1.6.0 ~7M-loss blow-up). Disable that mask for any
 *   run including this shard.
 */

import { FR_VOIE_TYPES } from "@mailwoman/codex/fr"

import { decomposeFrStreet } from "../adapters/ban/street-decompose.ts"
import { alignAndWrite, makeMulberry32, readTuples, type ShardRecipe, shardSourceID } from "./scaffold.ts"

/**
 * Canonical voie type (lowercase, accent-kept) → its most common written abbreviation, from the codex table's first
 * entry. Types with no attested abbreviation stay canonical in the abbreviated form.
 */
const FR_VOIE_ABBREV: Record<string, string> = Object.fromEntries(
	Object.entries(FR_VOIE_TYPES).flatMap(([canonical, abbrevs]) => (abbrevs[0] ? [[canonical, abbrevs[0]]] : []))
)

/**
 * Shard recipe registered with the corpus builder — see the file header for the parse behaviour it exists to exercise,
 * and `description` below for the surface form it generates.
 */
export const frBareStreetRecipe: ShardRecipe = {
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

			// The failing class is the prefix-led FR street; a no-prefix nom_voie ("La Ville Mois") isn't it.
			if (!prefix || !street) {
				skipped++

				continue
			}

			// Three surfaces over the same tuple, cycled deterministically. The comma form was the
			// original lever; the COMMA-FREE form is the colloquial register users actually type
			// ('12 rue de Rome Paris' — the street↔locality boundary with NO delimiter, the fr-fr
			// panel's named loss), and the ABBREVIATED form is the typeahead register ('12 r de Rome
			// Paris' / 'pl'-class voie abbreviations) the geocoder-tester FR slice attests at scale.
			// The TAGS are identical across all three; each component VALUE is the span as written
			// (the abbreviated form labels the abbreviation — BIO alignment binds value to surface).
			const form = read % 3
			const prefixSurface = form === 2 ? (FR_VOIE_ABBREV[prefix.toLowerCase()] ?? prefix) : prefix

			const components: Record<string, string> = {
				house_number: number,
				street_prefix: prefixSurface,
				street,
				locality,
			}

			const raw =
				form === 0 ? `${number} ${prefix} ${street}, ${locality}` : `${number} ${prefixSurface} ${street} ${locality}`

			const source_id = shardSourceID("synth-fr-bare-street", { ...components, f: String(form), v: String(read) })

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
