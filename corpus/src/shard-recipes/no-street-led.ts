/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `no-street-led` — the Norwegian street-led shard, third orthography of the #901
 *   leading-name-boundary family. The post-#920 NO row-read measured the residual as
 *   ORDER-SENSITIVE decode: street-led forms ("Tangavegen 40, 5620 Tørvikbygd") carry a 30%
 *   residual vs pc-first's 7% — the diacritic street head (…vegen/…veien with ø/å/æ) is the same
 *   leading-name-before-comma boundary the FR bare-street and SI village forms exercise, in a
 *   third orthography. All three real orders cycle per tuple (balanced polarity — the v1.9.9
 *   lesson: a one-order gradient loses at convergence):
 *
 *   1. canonical  "«st» «n», «pc» «city»"   (the 30% residual class — the lesson)
 *   2. city-first "«city», «pc», «st» «n»"
 *   3. pc-first   "«pc» «city», «st» «n»"   (the 7% floor — the anchor the others converge to)
 */

import { alignAndWrite, makeMulberry32, readTuples, type ShardRecipe, shardSourceID } from "./scaffold.ts"

export const noStreetLedRecipe: ShardRecipe = {
	name: "no-street-led",
	description: "NO street-led boundary form (#901 family): '«st» «n», «pc» «city»' — diacritic street heads",
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
				raw = `${street} ${number}, ${postcode} ${city}`
			} else if (order === 1) {
				raw = `${city}, ${postcode}, ${street} ${number}`
			} else {
				raw = `${postcode} ${city}, ${street} ${number}`
			}
			const source_id = shardSourceID("synth-no-street-led", { ...components, o: String(order), v: String(read) })
			const canonical = {
				raw,
				components,
				country: "NO",
				locale: "nb-NO",
				source: "synth-no-street-led",
				source_id,
				corpus_version: "0.10.0",
				license:
					"Synthetic — no-street-led; (street, number, postcode, city) from OpenAddresses NO (per-source attribution in the model card)",
			}

			if (alignAndWrite(write, canonical, "no-street-led")) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
