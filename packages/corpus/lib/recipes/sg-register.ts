/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `sg-register` slice recipe — the forms a person in Singapore types, rendered over the Overture-SG register rows
 *   (#2204 §4). The base `overture` source carries the register's own shape, `990 OLD CHOA CHU KANG ROAD, 699814,
 *   Singapore`, and the Latin model has no register for the three forms that dominate typed Singapore addresses:
 *
 *   - the HDB block line, `Blk 123 Ang Mo Kio Ave 3 #05-67 Singapore 560123` — `Blk` in front of the block number (the
 *     register's `number`), a floor-unit `#NN-NN` after the street, the country name as the locality;
 *   - the bracketed postcode, `123 Ang Mo Kio Ave 3 S(560123)` — the form the postal service prints;
 *   - the building-led line, `National Shooting Centre, 990 Old Choa Chu Kang Road, Singapore 699814` — the register's
 *     `unit` field holds the BUILDING or ESTATE name on 91,818 of 142,210 rows, which the adapter refuses as a unit and
 *     this recipe renders as a `venue` when it reads as a building rather than an estate.
 *
 *   Every value in `components` is a verbatim substring of `raw`, aligned by {@link alignAndWrite}. The floor-unit is
 *   SYNTHESIZED (the register carries one on a single row): floor 01–30, unit 01–399, zero-padded — the shape, not a
 *   real occupancy. `Blk` and the `S(` `)` around a postcode are untagged, as the board's `sg-cs-blk-12-kallang-ave`
 *   row expects (`house_number: "12"`). Streets arrive upper-case and are rendered title-cased; a third abbreviate the
 *   generic (`Avenue` → `Ave`, `Road` → `Rd`, …) the way a typed line does.
 *
 *   Run: mailwoman corpus slice sg-register --input <overture-sg.corpus.jsonl> --count N --seed S
 */

import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { titlecase } from "#adapters/gnaf/assemble"
import { alignAndWrite, type CorpusRecipe, readTuples, sliceSourceID } from "#recipes/scaffold"

const SOURCE = "synth-sg-register"

/**
 * The register's generics and the abbreviation a typed line uses for each.
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
 * Estate and area names the register's `unit` field carries beside building names. A name ending in one of these is an
 * estate, which no one writes in front of an address line; a name without one reads as a building and is rendered as a
 * `venue`.
 */
const ESTATE_TAILS = ["ESTATE", "CONSERVATION AREA", "HILLS", "PARK", "GARDENS", "GARDEN", "HEIGHTS", "GROVE", "VILLE"]

/**
 * Share of rows per register. The block line and the bracketed postcode are the two the Latin model has never seen; the
 * official line keeps the register's own shape in the mix so the block forms train beside it.
 */
const P_BLOCK = 0.4
const P_BRACKET_POSTCODE = 0.25
const P_BUILDING_LED = 0.15
const P_ABBREVIATE = 0.35
const P_UPPER = 0.1

const FLOOR_MAX = 30
const UNIT_MAX = 399

/**
 * The draw value that lands each register in the branch order below, for a caller that names the form.
 */
const REGISTER_DRAW: Record<SGRegister, number> = {
	block: 0,
	bracket_postcode: P_BLOCK,
	building_led: P_BLOCK + P_BRACKET_POSTCODE,
	official: 1,
}

/**
 * `OLD CHOA CHU KANG ROAD` → `Old Choa Chu Kang Road`; an already-mixed value is returned as it is. The register writes
 * every street and building name upper-case, the same convention as G-NAF, so the G-NAF title-caser serves both.
 */
export function titleCaseSGName(name: string): string {
	return name === name.toUpperCase() ? titlecase(name) : name
}

/**
 * Abbreviate the street's generic, wherever it sits (`Ang Mo Kio Avenue 3` → `Ang Mo Kio Ave 3`).
 */
export function abbreviateSGStreet(street: string): string {
	for (const [full, short] of GENERIC_ABBREVIATIONS) {
		const pattern = new RegExp(`\\b${full}\\b`, "u")

		if (pattern.test(street)) return street.replace(pattern, short)
	}

	return street
}

/**
 * Whether the register's `unit` value names a building rather than an estate — the building-led register's lead. A name
 * carrying a digit, a parenthesized abbreviation (`DIABETES & METABOLISM CENTRE (DMC)`) or one word only is not one.
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
 * The four typed forms this recipe renders.
 */
export type SGRegister = "official" | "block" | "bracket_postcode" | "building_led"

/**
 * One rendered register: the raw line plus the components it carries, every value a substring of the line.
 */
export interface SGRegisterRendering {
	raw: string
	components: Record<string, string>
	register: SGRegister
}

/**
 * Render one register form for one register row. Pure: every random draw comes through `random`. A `register` names the
 * form to render instead of drawing one, for a board that wants a balanced spread; `building_led` still needs a
 * building-shaped `unit` and falls back to `official` without one.
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
 * Slice recipe registered with the corpus builder — see the file header for the registers and why each is here.
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

				write(JSON.stringify(golden) + "\n")

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
					source_id: sliceSourceID(source, { raw: rendering.raw }),
					corpus_version: "0.1.0",
					license:
						"CDLA-Permissive-2.0 — Overture Maps addresses over the Singapore Open Data Licence 1.0 (OneMap / Singapore Land Authority)",
				},
				`sg-register:${rendering.register}`
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
