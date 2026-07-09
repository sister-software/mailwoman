/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `si-bare-village` — the Slovenian no-street counter-shard (#901 run-2). Slovenia's rural
 *   addressing has NO street line: the village name is the street-level token and repeats as the
 *   locality ("Zabiče 8, 6250 Zabiče"). The v1.9.8 gate FALSIFIED the fr-bare-street shard alone on
 *   exactly this class (SI resolve −3.4pp; "Apače 108" split into street "Apače 10" + house "8") —
 *   the bare-street boundary lesson generalizes onto a form where the leading name must keep its
 *   number whole and the trailing mention must stay locality-bound. This shard is the paired
 *   counter-distribution: same lesson ("name before number, comma, then admin"), opposite polarity
 *   on the trailing mention.
 *
 *   Three real-order templates cycle per tuple (mirrors the coord-golden orders so the eval and the
 *   training distribution agree):
 *
 *   1. canonical  "«V» «n», «pc» «V»"
 *   2. bare       "«V» «n», «V»"        (no postcode — the anchor-free form, the fr-bare lesson)
 *   3. pc-first   "«pc» «V», «V» «n»"
 *
 *   Gold spans: leading «V» = street (matches OA ground truth — the village IS the address line),
 *   «n» = house_number (NEVER split mid-digits), «pc» = postcode (never swallowing the neighbor),
 *   trailing «V» = locality (the binding the resolver needs).
 */

import { alignAndWrite, makeMulberry32, readTuples, type ShardRecipe, shardSourceID } from "./scaffold.ts"

export const siBareVillageRecipe: ShardRecipe = {
	name: "si-bare-village",
	description: "SI no-street village form (#901 run-2): '«V» «n», «pc» «V»' — the fr-bare-street counter-distribution",
	mode: "tuples",
	async run(opts, write) {
		makeMulberry32(opts.seed)
		let read = 0
		let emitted = 0
		let skipped = 0

		for await (const t of readTuples(opts.input!)) {
			read++
			const village = String(t.locality ?? "").trim()
			const number = String(t.number ?? "").trim()
			const postcode = String(t.postcode ?? "").trim()

			if (!village || !number || !postcode) {
				skipped++
				continue
			}
			const order = read % 3
			let raw: string
			const components: Record<string, string> = {
				street: village,
				house_number: number,
				locality: village,
			}

			if (order === 0) {
				components.postcode = postcode
				raw = `${village} ${number}, ${postcode} ${village}`
			} else if (order === 1) {
				raw = `${village} ${number}, ${village}`
			} else {
				components.postcode = postcode
				raw = `${postcode} ${village}, ${village} ${number}`
			}
			const source_id = shardSourceID("synth-si-bare-village", { ...components, o: String(order), v: String(read) })
			const canonical = {
				raw,
				components,
				country: "SI",
				locale: "sl-SI",
				source: "synth-si-bare-village",
				source_id,
				corpus_version: "0.9.9",
				license:
					"Synthetic — si-bare-village; (village, number, postcode) from OpenAddresses SI (per-source attribution in the model card)",
			}

			if (alignAndWrite(write, canonical, "si-bare-village")) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
