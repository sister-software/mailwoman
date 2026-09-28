/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `cz-pcfirst-preposition`: the Czech pc-first prepositional-locality recipe.
 *
 * A leading postcode is mis-assigned as a house number while a multi-word "nad/pod/u X" locality
 * shatters. This recipe supplies real prepositional localities in the order that breaks, so the
 * model learns that a leading postcode before a multi-word name is a postcode. pc-first leads the
 * cycle and the canonical and city-first orders keep the polarity balanced.
 */

import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { alignAndWrite, readTuples, requireRegister, type CorpusRecipe, recipeSourceID } from "#recipes/scaffold"
import { defaultRecipeSource } from "#recipes/sources"
import { SurfaceOrigin } from "#types"
/**
 * The order-cycle slot for the street-less form (`«city» «pc», Česko`).
 *
 * This is the surface of the `cz-full-praha-100-00` board row.
 * The street-containing orders do not cover it.
 */
const STREETLESS_ORDER = 3

/**
 * Recipe registered with the corpus builder.
 */
export const czPcFirstPrepositionRecipe: CorpusRecipe = {
	name: "cz-pcfirst-preposition",
	description:
		"CZ pc-first + prepositional locality (#901 family): '«pc» «city nad X», «st» «n»' — the #723 class as data",
	mode: "tuples",
	async run(opts, write) {
		makeMulberry32(opts.seed)
		let read = 0
		let emitted = 0
		let skipped = 0

		const CZ_PCFIRST_PROVENANCE = {
			register: requireRegister(opts, "cz-pcfirst-preposition"),
			surface: SurfaceOrigin.Composed,
		}

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

			const order = read % 4
			// The official Czech rendering spaces the PSČ as `NNN NN` ('512 44')
			// while OpenAddresses stores it unspaced ('51244').
			// Alternate the two renderings so both orthographies are attested.
			// Label the postcode in either form.
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
				// The street-less form `«city» «pc», Česko` omits street and number from the
				// components because the surface does not carry them.
				raw = `${city} ${postcodeSurface}, Česko`
			}

			// One resolution for both, because `source_id` carries the source as its prefix
			// and a pair that disagreed would name a source no row of this output declares.
			const source = defaultRecipeSource("synth-cz-pcfirst-preposition")

			const source_id = recipeSourceID(source, {
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
				source,
				source_id,
				corpus_version: "0.10.0",
				license:
					"Synthetic — cz-pcfirst-preposition; (street, number, postcode, city) from OpenAddresses CZ (per-source attribution in the model card)",
			}

			// Per row, because the id names this tuple's record.
			// A tuples file written before `sourceID` existed carries none.
			// `null` says the recipe had no id to forward.
			if (
				alignAndWrite(write, canonical, "cz-pcfirst-preposition", {
					...CZ_PCFIRST_PROVENANCE,
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
