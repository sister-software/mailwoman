/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Renders Overture Singapore address rows in the forms that people type, such as HDB block lines and `S(560123)` postcodes.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { titlecase } from "#au/adapters/gnaf/assemble"
import { alignAndWrite, type CorpusRecipe, readTuples, recipeSourceID } from "#recipes/scaffold"
import { SourceRegister } from "#registers"
import { SurfaceOrigin } from "#types"

const SOURCE = "synth-sg-register"

/**
 * Street generics and their typed abbreviations.
 */
const GENERIC_ABBREVIATIONS: ReadonlyArray<readonly [full: string, short: string]> = [
	["Avenue", "Ave"],
	["Road", "Rd"],
	["Street", "St"],
	["Drive", "Dr"],
	["Crescent", "Cres"],
	["Lane", "Ln"],
	["Boulevard", "Blvd"],
	["Terrace", "Ter"],
	["Place", "Pl"],
	["Close", "Cl"],
	["Walk", "Wk"],
]

/**
 * Name endings that mark an estate or area in the source `unit` field.
 *
 * People do not write an estate name before an address line, so the recipe
 * renders only building names as a `venue`.
 */
const ESTATE_TAILS = ["ESTATE", "CONSERVATION AREA", "HILLS", "PARK", "GARDENS", "GARDEN", "HEIGHTS", "GROVE", "VILLE"]

// The official form receives the probability left after the block, bracketed-postcode and building-led forms.
const P_BLOCK = 0.4
const P_BRACKET_POSTCODE = 0.25
const P_BUILDING_LED = 0.15
const P_ABBREVIATE = 0.35
const P_UPPER = 0.1

// The source rarely carries a floor-unit, so the recipe synthesizes one within these bounds.
const FLOOR_MAX = 30
const UNIT_MAX = 399

/**
 * The draw value that selects each form in {@link renderSGRegister} when a caller requests that form.
 */
const REGISTER_DRAW: Record<SGRegister, number> = {
	block: 0,
	bracket_postcode: P_BLOCK,
	building_led: P_BLOCK + P_BRACKET_POSTCODE,
	official: 1,
}

/**
 * Title-cases an all-uppercase name and returns any other name unchanged.
 *
 * The source writes names in uppercase like G-NAF, so the function reuses the G-NAF title-caser.
 */
export function titleCaseSGName(name: string): string {
	return name === name.toUpperCase() ? titlecase(name) : name
}

/**
 * Abbreviates the first street generic that the street contains, such as
 * `Ang Mo Kio Avenue 3` to `Ang Mo Kio Ave 3`.
 */
export function abbreviateSGStreet(street: string): string {
	for (const [full, short] of GENERIC_ABBREVIATIONS) {
		const pattern = new RegExp(`\\b${full}\\b`, "u")

		if (pattern.test(street)) return street.replace(pattern, short)
	}

	return street
}

/**
 * Reports whether the source `unit` value looks like a building name that can lead a line.
 *
 * The check rejects `NIL`, single words, values with a digit or parenthesis, and estate names.
 */
export function isBuildingName(unit: string): boolean {
	const value = unit.trim().toUpperCase()

	if (!value || value === "NIL" || /[\d()]/u.test(value) || !/\s/u.test(value)) return false

	return !ESTATE_TAILS.some((tail) => value.endsWith(tail))
}

interface SGRow {
	street: string
	number: string
	unit: string
	postcode: string
}

/**
 * The four typed forms that this recipe renders.
 */
export type SGRegister = "official" | "block" | "bracket_postcode" | "building_led"

/**
 * One rendered line with its components, each of which is a substring of `raw`.
 */
export interface SGRegisterRendering {
	raw: string
	components: Record<string, string>
	register: SGRegister
}

/**
 * Renders one source row in a sampled or requested form.
 *
 * All randomness comes from `random`.
 * A requested `building_led` form falls back to `official` when the row's `unit` is not a building name.
 *
 * A requested `block` form falls back to `bracket_postcode` when the row's number is not a block number.
 * `Blk` and the `S(` and `)` around a postcode stay untagged.
 */
export function renderSGRegister(row: SGRow, random: () => number, register?: SGRegister): SGRegisterRendering {
	const street0 = titleCaseSGName(row.street)
	const street = random() < P_ABBREVIATE ? abbreviateSGStreet(street0) : street0
	const drawn = random()
	const building = isBuildingName(row.unit) ? titleCaseSGName(row.unit) : null
	const draw = register === undefined ? drawn : REGISTER_DRAW[register]

	let raw: string
	let rendered: SGRegister
	const components: Record<string, string> = { house_number: row.number, street, postcode: row.postcode }

	if (draw < P_BLOCK && /^\d+[A-Z]?$/u.test(row.number)) {
		const floor = String(1 + Math.floor(random() * FLOOR_MAX)).padStart(2, "0")
		const unitNo = String(1 + Math.floor(random() * UNIT_MAX)).padStart(2, "0")
		const unit = `#${floor}-${unitNo}`

		raw = `Blk ${row.number} ${street} ${unit} Singapore ${row.postcode}`
		components.unit = unit
		components.locality = "Singapore"
		rendered = "block"
	} else if (draw < P_BLOCK + P_BRACKET_POSTCODE) {
		raw = `${row.number} ${street} S(${row.postcode})`
		rendered = "bracket_postcode"
	} else if (draw < P_BLOCK + P_BRACKET_POSTCODE + P_BUILDING_LED && building) {
		raw = `${building}, ${row.number} ${street}, Singapore ${row.postcode}`
		components.venue = building
		components.locality = "Singapore"
		rendered = "building_led"
	} else {
		raw = `${row.number} ${street} Singapore ${row.postcode}`
		components.locality = "Singapore"
		rendered = "official"
	}

	if (random() < P_UPPER) {
		raw = raw.toUpperCase()

		for (const key of Object.keys(components)) {
			components[key] = components[key]!.toUpperCase()
		}
	}

	return { raw, components, register: rendered }
}

/**
 * Renders each Overture Singapore corpus row from `--input` once in a sampled typed form.
 *
 * The recipe skips rows without a street, a block-style number, or a six-digit postcode.
 */
export const sgRegisterRecipe: CorpusRecipe = {
	name: "sg-register",
	description:
		"Singapore typed registers over the Overture-SG rows: the HDB block line with a #NN-NN unit, the S(NNNNNN) postcode, the building-led line",
	mode: "tuples",
	options: [
		{ flag: "--count", description: "Rows to emit (default: every input row once)" },
		{ flag: "--input", description: "The Overture-SG corpus JSONL ({ street, number, unit, postcode, locality })" },
	],
	async run(opts, write) {
		if (!opts.input) {
			throw new Error("sg-register: --input <overture-sg.corpus.jsonl> is required")
		}

		const random = makeMulberry32(opts.seed)
		const source = opts.sourceName ?? SOURCE
		const registers: Record<string, number> = {}
		let read = 0
		let emitted = 0
		let skipped = 0
		let quarantined = 0

		for await (const tuple of readTuples(opts.input)) {
			read++

			if (opts.count !== undefined && emitted >= opts.count) break

			const street = typeof tuple["street"] === "string" ? tuple["street"].trim() : ""
			const number = typeof tuple["number"] === "string" ? tuple["number"].trim() : ""
			const postcode = typeof tuple["postcode"] === "string" ? tuple["postcode"].trim() : ""
			const unit = typeof tuple["unit"] === "string" ? tuple["unit"].trim() : ""

			if (!street || !/^\d+[A-Z]?$/u.test(number) || !/^\d{6}$/u.test(postcode)) {
				skipped++

				continue
			}

			const rendering = renderSGRegister({ street, number, unit, postcode }, random)

			if (opts.golden) {
				const golden = { raw: rendering.raw, components: rendering.components, country: "SG", locale: "en-SG" }

				write(stringifyJSON(golden))

				emitted++
				registers[rendering.register] = (registers[rendering.register] ?? 0) + 1

				continue
			}

			const ok = alignAndWrite(
				write,
				{
					raw: rendering.raw,
					components: rendering.components,
					country: "SG",
					locale: "en-SG",
					source,
					source_id: recipeSourceID(source, { raw: rendering.raw }),
					corpus_version: "0.1.0",
					license:
						"CDLA-Permissive-2.0 — Overture Maps addresses over the Singapore Open Data Licence 1.0 (OneMap / Singapore Land Authority)",
				},
				`sg-register:${rendering.register}`,
				// The values come from Overture, and only their arrangement is synthetic.
				{ register: SourceRegister.Overture, surface: SurfaceOrigin.Composed }
			)

			if (ok) {
				emitted++
				registers[rendering.register] = (registers[rendering.register] ?? 0) + 1
			} else {
				quarantined++
			}
		}

		console.error(
			`  sg-register: ${emitted} emitted (${Object.entries(registers)
				.map(([k, v]) => `${k} ${v}`)
				.join(", ")}), ${skipped} skipped, ${quarantined} quarantined of ${read} read`
		)

		return { read, emitted, skipped }
	},
}
