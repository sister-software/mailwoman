/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `nl-postcode` — the Dutch full-form postcode shard (#924). The model reads the DIGITS-FIRST NL
 *   postcode "1012 LG" as a house number + a 2-letter street ("1012 LG Amsterdam" → house_number
 *   1012 / street "LG" / locality Amsterdam), and that spurious street context then pulls the
 *   locality into the US situs tier (Amsterdam → Amsterdam, NY). Letters-first postcodes (UK
 *   "SW1A 1AA") parse natively; the `\d{4} [A-Z]{2}` shape does not, and the soft query-shape prior
 *   (0.9 log-odds) can't overcome the strong house-number reading of a leading 4-digit token.
 *
 *   This is the model-first fix as DATA (the #723/#901 discipline — teach the boundary, don't
 *   override the decoder): real NL (street, number, postcode, city) tuples in the orders Dutch
 *   addresses actually use, with the full postcode tagged as ONE postcode span. Both the SPACED
 *   ("1012 LG", the failing form — a 2-token span) and UNSPACED ("1012LG", 1 token) forms are
 *   emitted so the model learns the digits-first postcode regardless of spacing; the three orders
 *   keep polarity balanced (the v1.9.9 lesson).
 */

import { alignAndWrite, makeMulberry32, readTuples, type ShardRecipe, shardSourceID } from "./scaffold.js"

/** "1012LG" → "1012 LG". The tuples carry the unspaced OA form; the spaced form is the failing case. */
function spacePostcode(pc: string): string {
	return pc.replace(/^(\d{4})([A-Z]{2})$/, "$1 $2")
}

export const nlPostcodeRecipe: ShardRecipe = {
	name: "nl-postcode",
	description:
		"NL full-form postcode (#924): teach '\\d{4} [A-Z]{2}' = postcode, not house#+street — spaced + unspaced, 3 orders",
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
			const rawPostcode = String(t.postcode ?? "")
				.trim()
				.toUpperCase()
				.replace(/\s+/g, "")

			if (!street || !city || !number || !/^\d{4}[A-Z]{2}$/.test(rawPostcode)) {
				skipped++
				continue
			}

			// Spacing rotates so the model sees BOTH the failing spaced form and the unspaced form; the
			// components.postcode value MUST match the raw form so alignment tags the right span.
			const spaced = read % 2 === 0
			const postcode = spaced ? spacePostcode(rawPostcode) : rawPostcode

			// The three orders Dutch addresses use. `street number, postcode city` is canonical; the
			// pc-first form is where the leading digits most strongly mis-read as a house number.
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
			const source_id = shardSourceID("synth-nl-postcode", {
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

			if (alignAndWrite(write, canonical, "nl-postcode")) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
