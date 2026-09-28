/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `si-bare-village`, the Slovenian no-street counter-recipe. Slovenia's rural addressing has no
 *   street line, so the village name is the street-level token and repeats as the locality
 *   ("Zabiče 8, 6250 Zabiče"). The leading name must keep its number whole, and the trailing mention
 *   must stay locality-bound. This recipe is the paired counter-distribution, with the same lesson
 *   ("name before number, comma, then admin") and the opposite polarity on the trailing mention.
 *
 *   Three real-order templates cycle per tuple (mirrors the coord-golden orders so the eval and the
 *   training distribution agree):
 *
 *   1. canonical  "«V» «n», «pc» «V»"
 *   2. bare       "«V» «n», «V»"        (no postcode, the anchor-free form)
 *   3. pc-first   "«pc» «V», «V» «n»"
 *
 *   Gold spans: leading «V» = street (matches OA ground truth, the village is the address line),
 *   «n» = house_number (never split mid-digits), «pc» = postcode (never swallowing the neighbor),
 *   trailing «V» = locality (the binding the resolver needs).
 */

import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { alignAndWrite, readTuples, requireRegister, type CorpusRecipe, recipeSourceID } from "#recipes/scaffold"
import { defaultRecipeSource } from "#recipes/sources"
import { SurfaceOrigin } from "#types"

/**
 * Recipe registered with the corpus builder.
 *
 * See the file header for the parse behaviour it exists to exercise,
 * and `description` below for the surface form it generates.
 */
export const siBareVillageRecipe: CorpusRecipe = {
	name: "si-bare-village",
	description: "SI no-street village form (#901 run-2): '«V» «n», «pc» «V»' — the fr-bare-street counter-distribution",
	mode: "tuples",
	async run(opts, write) {
		makeMulberry32(opts.seed)
		let read = 0
		let emitted = 0
		let skipped = 0

		const SI_BARE_VILLAGE_PROVENANCE = {
			register: requireRegister(opts, "si-bare-village"),
			surface: SurfaceOrigin.Composed,
		}

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

			// One resolution for both, because `source_id` carries the source as its prefix
			// and a pair that disagreed would name a source no row of this output declares.
			const source = defaultRecipeSource("synth-si-bare-village")
			const source_id = recipeSourceID(source, { ...components, o: String(order), v: String(read) })

			const canonical = {
				raw,
				components,
				country: "SI",
				locale: "sl-SI",
				source,
				source_id,
				corpus_version: "0.9.9",
				license:
					"Synthetic — si-bare-village; (village, number, postcode) from OpenAddresses SI (per-source attribution in the model card)",
			}

			// Per row rather than on the shared literal, because the id names this tuple's record.
			// A tuples file written before `sourceID` existed carries none, and `null` says so.
			if (
				alignAndWrite(write, canonical, "si-bare-village", {
					...SI_BARE_VILLAGE_PROVENANCE,
					baseSourceID: t.sourceID ?? null,
				})
			) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
