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

/**
 * The order-cycle slot for the STREET-LESS form (`«city» «pc», Česko`) — the exact surface of the
 * `cz-full-praha-100-00` board row, whose absence from the street-bearing orders was the v4.5.0 no-promote's measured
 * gap.
 */
const STREETLESS_ORDER = 3

/**
 * Shard recipe registered with the corpus builder — see the file header for the parse behaviour it exists to exercise,
 * and `description` below for the surface form it generates.
 */
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

		for await (const t of await readTuples(opts.input!)) {
			read++
			const street = String(t.street ?? "").trim()
			const city = String(t.locality ?? "").trim()
			const number = String(t.number ?? "").trim()
			const postcode = String(t.postcode ?? "").trim()

			if (!street || !city || !number || !postcode) {
				skipped++

				continue
			}

			const order = read % 4
			// The OFFICIAL Czech rendering spaces the PSČ as `NNN NN` ('512 44'); OpenAddresses stores it
			// unspaced ('51244'), and a model trained only on the source form reads the spaced surface as
			// house_number + garbage (the 'Praha 100 00' mangle). Alternate the two renderings so both
			// orthographies are attested — the LABEL is the postcode either way.
			const spaced = read % 2 === 0 && /^\d{5}$/.test(postcode)
			const postcodeSurface = spaced ? `${postcode.slice(0, 3)} ${postcode.slice(3)}` : postcode
			let raw: string

			const components: Record<string, string> =
				order === STREETLESS_ORDER
					? { locality: city, postcode: postcodeSurface, country: "Česko" }
					: { street, house_number: number, postcode: postcodeSurface, locality: city }

			if (order === 0) {
				raw = `${postcodeSurface} ${city}, ${street} ${number}`
			} else if (order === 1) {
				raw = `${street} ${number}, ${postcodeSurface} ${city}`
			} else if (order === 2) {
				raw = `${city}, ${postcodeSurface}, ${street} ${number}`
			} else {
				// order === STREETLESS_ORDER: the street-less form — `«city» «pc», Česko` — the exact surface of the
				// cz-full-praha-100-00 board row. The v4.5.0 no-promote receipt measured the gap: every
				// prior order was street-bearing, so the model never saw a spaced PSČ beside a bare
				// locality and mangled 'Praha 100 00, Czechia' into house_number spans. Street/number
				// stay OUT of the components for this form (they are not in the surface).
				raw = `${city} ${postcodeSurface}, Česko`
			}

			const source_id = shardSourceID("synth-cz-pcfirst-preposition", {
				...components,
				o: String(order),
				s: spaced ? "1" : "0",
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
