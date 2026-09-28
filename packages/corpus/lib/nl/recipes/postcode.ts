/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `nl-postcode`: the Dutch full-form postcode recipe.
 *
 * The model reads the digits-first NL postcode "1012 LG" as a house number plus a two-letter
 * street, so "1012 LG Amsterdam" becomes house_number 1012, street "LG", locality Amsterdam. That
 * spurious street context then pulls the locality into the US situs tier. The `\d{4} [A-Z]{2}`
 * shape does not parse natively, and the soft query-shape prior cannot overcome the strong
 * house-number reading of a leading four-digit token.
 *
 * This recipe is the model-first fix as data. It supplies real NL (street, number, postcode, city)
 * tuples in the orders Dutch addresses use, with the full postcode tagged as one postcode span. Both
 * the spaced and unspaced forms are emitted so the model learns the digits-first postcode regardless
 * of spacing, and the three orders keep polarity balanced.
 */

import { isNLPostcodeKey } from "@mailwoman/codex/nl"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { alignAndWrite, readTuples, requireRegister, type CorpusRecipe, recipeSourceID } from "#recipes/scaffold"
import { SurfaceOrigin } from "#types"

/**
 * "1012LG" → "1012 LG".
 *
 * The tuples carry the unspaced OA form.
 * The spaced form is the failing case.
 */
function spacePostcode(pc: string): string {
	return pc.replace(/^(\d{4})([A-Z]{2})$/, "$1 $2")
}

/**
 * Recipe registered with the corpus builder.
 */
export const nlPostcodeRecipe: CorpusRecipe = {
	name: "nl-postcode",
	description:
		"NL full-form postcode (#924): teach '\\d{4} [A-Z]{2}' = postcode, not house#+street — spaced + unspaced, 3 orders",
	mode: "tuples",
	async run(opts, write) {
		makeMulberry32(opts.seed)
		let read = 0
		let emitted = 0
		let skipped = 0

		const NL_POSTCODE_PROVENANCE = {
			register: requireRegister(opts, "nl-postcode"),
			surface: SurfaceOrigin.Composed,
		}

		for await (const t of readTuples(opts.input!)) {
			read++
			const street = String(t.street ?? "").trim()
			const city = String(t.locality ?? "").trim()
			const number = String(t.number ?? "").trim()

			const rawPostcode = String(t.postcode ?? "")
				.trim()
				.toUpperCase()
				.replaceAll(/\s+/g, "")

			if (!street || !city || !number || !isNLPostcodeKey(rawPostcode)) {
				skipped++

				continue
			}

			// Spacing rotates so the model sees both the failing spaced form and the unspaced form.
			// The components.postcode value must match the raw form so alignment tags the right span.
			const spaced = read % 2 === 0
			const postcode = spaced ? spacePostcode(rawPostcode) : rawPostcode

			// The three orders Dutch addresses use.
			// `street number, postcode city` is canonical.
			// The pc-first form is where the leading digits most strongly mis-read as a house number.
			const order = read % 3
			let raw: string

			if (order === 0) {
				raw = `${street} ${number}, ${postcode} ${city}`
			} else if (order === 1) {
				raw = `${postcode} ${city}, ${street} ${number}`
			} else {
				raw = `${city}, ${postcode}, ${street} ${number}`
			}

			const components: Record<string, string> = {
				street,
				house_number: number,
				postcode,
				locality: city,
			}

			const source_id = recipeSourceID("synth-nl-postcode", {
				...components,
				o: String(order),
				s: spaced ? "1" : "0",
				v: String(read),
			})

			const canonical = {
				raw,
				components,
				country: "NL",
				locale: "nl-NL",
				source: "synth-nl-postcode",
				source_id,
				corpus_version: "0.10.0",
				license:
					"Synthetic — nl-postcode; (street, number, postcode, city) from OpenAddresses NL (per-source attribution in the model card)",
			}

			if (alignAndWrite(write, canonical, "nl-postcode", NL_POSTCODE_PROVENANCE)) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
