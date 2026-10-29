/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The secondary-address recipe output (#1100, #456): labeled rows for units, floors, buildings and the EU
 *   entrance and staircase forms, each set in a full address so the street and admin tags stay anchored.
 *
 *   The designators are a curated draw from USPS Pub-28 Appendix C2 (units) and the codex level-semantics lexicons.
 *   `@mailwoman/codex` holds the full tables the runtime uses. Every row stores code-point span offsets built by
 *   cursor tracking, and {@linkcode checkSecondaryRows} refuses a row whose span is out of bounds, overlapping or
 *   blank before anything is written.
 *
 *   The STAGE4 tags these rows emit collapse to `O` until a STAGE4 label set is active.
 *
 *   The draws follow the Python builder's, from {@linkcode PyRandom} seeded with {@linkcode SECONDARY_SEED}, so the
 *   output rows equal the rows `corpora/secondary.py` wrote.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { pythonSplitWhitespace, pythonStrip } from "@mailwoman/core/strings/python-text"

import { PyRandom } from "#training/pyrandom"

/**
 * The corpus source of every row.
 */
export const SECONDARY_SOURCE = "synthetic-secondary"

/**
 * The generator seed.
 */
export const SECONDARY_SEED = 20_260_714

/**
 * The default base-repeat factor.
 * The output holds `cap × 24` rows.
 */
export const SECONDARY_DEFAULT_CAP = 400

/**
 * The tags {@linkcode secondaryTagCoverage} reports.
 */
export const SECONDARY_STAGE4_TAGS: readonly string[] = [
	"unit_designator",
	"unit",
	"level_designator",
	"level_id",
	"building_designator",
	"building_id",
	"entrance",
	"staircase",
]

// US secondary unit designators that take a following id (Pub-28 C2, the range-taking subset).
const US_UNIT_DESIGNATORS = ["APT", "STE", "UNIT", "RM", "DEPT", "OFC", "TRLR", "LOT", "SPC", "SLIP", "PIER"]
const US_LEVEL_DESIGNATORS = ["FL", "FLR", "FLOOR"]
const US_BUILDING_DESIGNATORS = ["BLDG", "BUILDING", "PH", "TWR"]
// EU entrance and staircase whole-phrase forms (codex level-semantics locales de-AT, de-DE, nl, fr).
const EU_ENTRANCES = ["Eingang 2", "Eingang A", "Aufgang 3", "opgang B", "Entrée C", "Escalier 4"]
const EU_STAIRCASES = ["Stiege 4", "Stiege 2", "Trappenhuis 1", "Cage B", "Escalera 3"]
const LEVEL_IDS = ["1", "2", "3", "4", "5", "10", "12", "3F", "B1"]
const BARE_LEVEL_IDS = ["3F", "B1", "2F", "1F"]
const UNIT_IDS = ["100", "200", "4B", "12", "711", "305", "A", "17", "2C"]
const BUILDING_IDS = ["A", "B", "C", "1", "2", "North", "West"]

/**
 * Every unit, level and building designator and every entrance and staircase phrase these rows draw.
 */
export const SECONDARY_DESIGNATOR_FORMS: readonly string[] = [
	...US_UNIT_DESIGNATORS,
	...US_LEVEL_DESIGNATORS,
	...US_BUILDING_DESIGNATORS,
	...EU_ENTRANCES,
	...EU_STAIRCASES,
]

// Base addresses: street, number, city, region, postcode.
const US_BASES: ReadonlyArray<readonly [string, string, string, string, string]> = [
	["Main St", "123", "Portland", "OR", "97214"],
	["Oak Avenue", "456", "Chicago", "IL", "60614"],
	["Elm Boulevard", "789", "Miami", "FL", "33101"],
	["5th Ave", "1600", "New York", "NY", "10019"],
	["Bouverie Street", "139", "Melbourne", "VIC", "3000"],
	["Pine Road", "42", "Austin", "TX", "78701"],
	["Market Street", "1355", "San Francisco", "CA", "94103"],
	["Congress Ave", "600", "Austin", "TX", "78701"],
]

// Base addresses: street, number, city, country.
const EU_BASES: ReadonlyArray<readonly [string, string, string, string]> = [
	["Hauptstraße", "12", "Berlin", "DE"],
	["Mariahilfer Straße", "88", "Wien", "AT"],
	["Damrak", "1", "Amsterdam", "NL"],
	["Rue de Rivoli", "24", "Paris", "FR"],
	["Gran Vía", "31", "Madrid", "ES"],
]

// The punctuated and the whitespace-only group separators (#1101).
const GROUP_SEPARATORS = [", ", " "] as const

/**
 * One tagged part of a group.
 */
type Part = readonly [tag: string, text: string]

/**
 * One secondary-address row, in the key order the Python builder wrote.
 */
export interface SecondaryRow {
	raw: string
	tokens: string[]
	labels: string[]
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
	source: string
}

const codePoints = (text: string): number => [...text].length

/**
 * A row from ordered groups.
 *
 * Parts within a group join with a space, because a designator and its id are one
 * unit (`STE 200`); groups join with `separator`.
 * Offsets are code points.
 */
function rowFromGroups(groups: ReadonlyArray<readonly Part[]>, separator: string): SecondaryRow {
	const row: SecondaryRow = {
		raw: "",
		tokens: [],
		labels: [],
		span_starts: [],
		span_ends: [],
		span_tags: [],
		source: SECONDARY_SOURCE,
	}

	const surfaces: string[] = []
	let cursor = 0

	for (const [groupIndex, group] of groups.entries()) {
		if (groupIndex > 0) {
			cursor += codePoints(separator)
		}

		const parts: string[] = []

		for (const [partIndex, [tag, text]] of group.entries()) {
			if (partIndex > 0) {
				cursor += 1
			}

			const tokens = pythonSplitWhitespace(text)

			row.tokens.push(...tokens)
			row.labels.push(`B-${tag}`, ...tokens.slice(1).map(() => `I-${tag}`))
			row.span_starts.push(cursor)
			row.span_ends.push(cursor + codePoints(text))
			row.span_tags.push(tag)
			parts.push(text)
			cursor += codePoints(text)
		}

		surfaces.push(parts.join(" "))
	}

	row.raw = surfaces.join(separator)

	return row
}

/**
 * The secondary forms to set into one base address, drawn in the Python builder's order.
 */
function secondaryForms(rng: PyRandom): Part[][] {
	return [
		[
			["unit_designator", rng.choice(US_UNIT_DESIGNATORS)],
			["unit", rng.choice(UNIT_IDS)],
		],
		[
			["level_designator", rng.choice(US_LEVEL_DESIGNATORS)],
			["level_id", rng.choice(LEVEL_IDS)],
		],
		[["level_id", rng.choice(BARE_LEVEL_IDS)]],
		[
			["building_designator", rng.choice(US_BUILDING_DESIGNATORS)],
			["building_id", rng.choice(BUILDING_IDS)],
		],
		[["entrance", rng.choice(EU_ENTRANCES)]],
		[["staircase", rng.choice(EU_STAIRCASES)]],
	]
}

/**
 * Every secondary row: each base address with each secondary form, punctuated
 * and whitespace-only, in US and EU order.
 * The rows are fixed by `cap` and {@linkcode SECONDARY_SEED}.
 */
export function generateSecondaryRows(cap: number): SecondaryRow[] {
	const rng = new PyRandom(SECONDARY_SEED)
	const rows: SecondaryRow[] = []

	for (let repeat = 0; repeat < cap; repeat++) {
		for (const separator of GROUP_SEPARATORS) {
			for (const form of secondaryForms(rng)) {
				const [street, number, city, region, postcode] = rng.choice(US_BASES)

				rows.push(
					rowFromGroups(
						[
							[
								["house_number", number],
								["street", street],
							],
							form,
							[["locality", city]],
							[
								["region", region],
								["postcode", postcode],
							],
						],
						separator
					)
				)

				const [euStreet, euNumber, euCity] = rng.choice(EU_BASES)

				rows.push(
					rowFromGroups(
						[
							[
								["street", euStreet],
								["house_number", euNumber],
							],
							form,
							[["locality", euCity]],
						],
						separator
					)
				)
			}
		}
	}

	return rows
}

/**
 * Refuses a row whose span is out of bounds, overlaps the one before it, or covers only whitespace.
 *
 * @throws On the first such span, naming it and the row.
 */
export function checkSecondaryRows(rows: readonly SecondaryRow[]): void {
	for (const row of rows) {
		const characters = [...row.raw]
		const quoted = stringifyJSON(row.raw)
		let previousEnd = -1

		for (const [index, start] of row.span_starts.entries()) {
			const end = row.span_ends[index]!

			if (!(start >= 0 && start < end && end <= characters.length)) {
				throw new Error(`span [${start},${end}) out of bounds for ${quoted}`)
			}

			if (start < previousEnd) throw new Error(`span [${start},${end}) overlaps previous in ${quoted}`)

			previousEnd = end

			if (!pythonStrip(characters.slice(start, end).join(""))) {
				throw new Error(`empty span text for tag ${row.span_tags[index]} in ${quoted}`)
			}
		}
	}
}

/**
 * Spans per STAGE4 tag, in tag-name order, for the tags in {@linkcode SECONDARY_STAGE4_TAGS}.
 */
export function secondaryTagCoverage(rows: readonly SecondaryRow[]): Map<string, number> {
	const counts = new Map<string, number>()

	for (const row of rows) {
		for (const tag of row.span_tags) {
			counts.set(tag, (counts.get(tag) ?? 0) + 1)
		}
	}

	return new Map(
		[...counts.keys()]
			.filter((tag) => SECONDARY_STAGE4_TAGS.includes(tag))
			.toSorted()
			.map((tag) => [tag, counts.get(tag)!])
	)
}
