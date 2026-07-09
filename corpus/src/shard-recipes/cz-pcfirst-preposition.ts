/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `cz-pcfirst-preposition` — the Czech pc-first prepositional-locality shard, fourth orthography
 *   of the #901 leading-name-boundary family. The #897 close-out read all 8 residual CZ rows as one
 *   class: a LEADING postcode mis-assigned as house_number while the multi-word "nad/pod/u X"
 *   locality shatters ("51244 Rokytnice nad Jizerou, Dolní Rokytnice 111" → street
 *   'RokytnicenadJizerou' + house_number '51244'). That leading-5-digit confusion is the
 *   anchor-pollution class whose decode-time OVERRIDE was correctly killed in #723 — this shard is
 *   the model-first fix as DATA: real prepositional localities in the order that breaks, so the
 *   model learns that a leading postcode before a multi-word name is a postcode. pc-first leads the
 *   cycle (the lesson); canonical and city-first keep the polarity balanced (the v1.9.9 lesson).
 */

import { alignAndWrite, makeMulberry32, readTuples, type ShardRecipe, shardSourceID } from "./scaffold.ts"

export const czPcFirstPrepositionRecipe: ShardRecipe = {
	name: "cz-pcfirst-preposition",
	description:
		"CZ pc-first + prepositional locality (#901 family): '«pc» «city nad X», «st» «n»' — the #723 class as data",
	mode: "tuples",
	async run(opts, write) {
		makeMulberry32(opts.seed)
		let read = 0
		let emitted = 0
		let skipped = 0

		for await (const t of readTuples(opts.input!)) {
			read++
			const street = String(t.street ?? "").trim()
			const city = String(t.locality ?? "").trim()
			const number = String(t.number ?? "").trim()
			const postcode = String(t.postcode ?? "").trim()

			if (!street || !city || !number || !postcode) {
				skipped++
				continue
			}
			const order = read % 3
			let raw: string
			const components: Record<string, string> = {
				street,
				house_number: number,
				postcode,
				locality: city,
			}

			if (order === 0) {
				raw = `${postcode} ${city}, ${street} ${number}`
			} else if (order === 1) {
				raw = `${street} ${number}, ${postcode} ${city}`
			} else {
				raw = `${city}, ${postcode}, ${street} ${number}`
			}
			const source_id = shardSourceID("synth-cz-pcfirst-preposition", {
				...components,
				o: String(order),
				v: String(read),
			})
			const canonical = {
				raw,
				components,
				country: "CZ",
				locale: "cs-CZ",
				source: "synth-cz-pcfirst-preposition",
				source_id,
				corpus_version: "0.10.0",
				license:
					"Synthetic — cz-pcfirst-preposition; (street, number, postcode, city) from OpenAddresses CZ (per-source attribution in the model card)",
			}

			if (alignAndWrite(write, canonical, "cz-pcfirst-preposition")) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
