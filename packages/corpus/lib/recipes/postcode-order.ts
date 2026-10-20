/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `postcode-order` — a real address written with its postcode on the side of the locality its country does not use.
 *
 *   A French address arrives as `«postcode» «locality»` in every source, so `Via del Corso 12, Roma 00186` or
 *   `Av. Paulista 1000, 01310-100 São Paulo` is a sequence the model has not been trained on. This recipe reads
 *   tuples from `tools/postcode-order-tuples`, keeps the source's street and house-number order, and writes the
 *   postcode in the slot opposite the native one. The native slot comes from libaddressinput's `fmt` through
 *   `postcodePlacement`, so a country whose layout states no order yields no rows rather than a guessed one.
 *
 *   Every row is labeled `postcode-order-<base source>`. `corpus-source-inputs.json` declares the `postcode-order`
 *   derivation, so each label inherits its base source's register inputs and license decision.
 */

import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import { postcodePlacement } from "@mailwoman/postcode/country-formats"

import { alignAndWrite, type CorpusRecipe, readTuples, recipeSourceID, requireRegister } from "#recipes/scaffold"
import { SurfaceOrigin } from "#types"

/**
 * The derivation prefix of every output label, as `corpus-source-inputs.json` declares it.
 */
export const POSTCODE_ORDER_SOURCE_PREFIX = "postcode-order"

/**
 * The output label for rows derived from `baseSource`.
 */
export function postcodeOrderSource(baseSource: string): string {
	return `${POSTCODE_ORDER_SOURCE_PREFIX}-${baseSource}`
}

// A draw below `COMMA_JOIN` joins the address and the admin tail with a comma, below `NEWLINE_JOIN`
// with a line break, and otherwise with a space, the comma-free form a user types into one search box.
const COMMA_JOIN = 0.8
const NEWLINE_JOIN = 0.92

// The share of tails that put a comma between the locality and the postcode (`Roma, 00186`).
const TAIL_COMMA_SHARE = 0.3

// The share of street-first addresses written with a comma before the house number (`Av. Paulista, 1000`).
const HOUSE_NUMBER_COMMA_SHARE = 0.3

/**
 * The fields the recipe reads from one tuple.
 */
export interface PostcodeOrderFields {
	house_number: string
	street: string
	locality: string
	postcode: string
	cc: string
	source: string
	license: string
	streetFirst: boolean
	baseSourceID: string | null
}

/**
 * A tuple's fields, trimmed, or null when one of the four components is missing.
 */
function fieldsOf(tuple: Record<string, unknown>): PostcodeOrderFields | null {
	const text = (key: string) => (typeof tuple[key] === "string" ? tuple[key].trim() : "")

	const fields = {
		house_number: text("house_number"),
		street: text("street"),
		locality: text("locality"),
		postcode: text("postcode"),
		cc: text("cc").toUpperCase(),
		source: text("source"),
		license: text("license"),
		streetFirst: tuple["streetFirst"] === true,
		baseSourceID: text("baseSourceID") || null,
	}

	if (!fields.house_number || !fields.street || !fields.locality || !fields.postcode || !fields.cc) return null

	if (!fields.source) return null

	return fields
}

/**
 * Renders one tuple with the postcode opposite its country's native slot,
 * or returns null when the country's layout states no order.
 */
export function renderPostcodeOrder(fields: PostcodeOrderFields, random: () => number): string | null {
	const native = postcodePlacement(fields.cc)

	if (!native) return null

	const { house_number: hn, street, locality, postcode } = fields

	const address = fields.streetFirst
		? `${street}${random() < HOUSE_NUMBER_COMMA_SHARE ? ", " : " "}${hn}`
		: `${hn} ${street}`

	const tailSeparator = random() < TAIL_COMMA_SHARE ? ", " : " "

	const tail =
		native === "before_locality" ? `${locality}${tailSeparator}${postcode}` : `${postcode}${tailSeparator}${locality}`

	const join = random()
	const joiner = join < COMMA_JOIN ? ", " : join < NEWLINE_JOIN ? "\n" : " "

	return `${address}${joiner}${tail}`
}

/**
 * Recipe registered with the corpus builder.
 */
export const postcodeOrderRecipe: CorpusRecipe = {
	name: "postcode-order",
	description:
		"Real addresses with the postcode on the locality side their country does not use, labeled postcode-order-<base source>",
	mode: "tuples",
	async run(opts, write) {
		const random = makeMulberry32(opts.seed)
		const provenance = { register: requireRegister(opts, "postcode-order"), surface: SurfaceOrigin.Composed }
		let baseSource: string | null = null
		let read = 0
		let emitted = 0
		let skipped = 0

		for await (const tuple of readTuples(opts.input!)) {
			read++

			const fields = fieldsOf(tuple)

			if (!fields) {
				skipped++

				continue
			}

			// One run writes one label, so the overlay file it becomes holds one source and one register.
			if (baseSource && fields.source !== baseSource) {
				throw new Error(
					`postcode-order read tuples from ${baseSource} and ${fields.source} in one input. ` +
						"Write one tuples file per source, as `writePostcodeOrderTuples` does."
				)
			}

			baseSource = fields.source

			const raw = renderPostcodeOrder(fields, random)

			if (!raw) {
				skipped++

				continue
			}

			const source = postcodeOrderSource(fields.source)

			const components = {
				house_number: fields.house_number,
				street: fields.street,
				locality: fields.locality,
				postcode: fields.postcode,
			}

			const canonical = {
				raw,
				components,
				country: fields.cc,
				locale: "und",
				source,
				source_id: recipeSourceID(source, { ...components, base: fields.baseSourceID ?? "", v: String(read) }),
				license: fields.license,
			}

			if (alignAndWrite(write, canonical, "postcode-order", { ...provenance, baseSourceID: fields.baseSourceID })) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
