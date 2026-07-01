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

import { decomposeFrStreet } from "../adapters/ban/street-decompose.js"
import { alignAndWrite, makeMulberry32, readTuples, type ShardRecipe, shardSourceID } from "./scaffold.js"

export const frBareStreetRecipe: ShardRecipe = {
	name: "fr-bare-street",
	description:
		"FR bare comma-form street+city, NO postcode (#251): '<n> Rue <name>, <City>' — the postcode-anchoring lever",
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
			const components: Record<string, string> = {
				house_number: number,
				street_prefix: prefix,
				street,
				locality,
			}
			// BARE comma form, number-before (FR's dominant order), NO postcode — the whole point.
			const raw = `${number} ${prefix} ${street}, ${locality}`
			const source_id = shardSourceID("synth-fr-bare-street", { ...components, v: String(read) })
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

			if (alignAndWrite(write, canonical, "fr-bare-street")) emitted++
			else skipped++
		}

		return { read, emitted, skipped }
	},
}
