/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The `fragment-assay` renderers: one harvested surface or field set into one labeled row.
 *
 *   Each renderer joins the pieces into `raw` and advances a cursor over the same pieces for the span
 *   offsets, counted in code points as the Python builder counted them. The tokens are the whitespace
 *   tokens of each field, labeled `B-<tag>` then `I-<tag>`.
 */

import { COUNTRY_SURFACE_FORMS, ISO2_TO_NAME } from "@mailwoman/codex/country"
import { codePointLength } from "@mailwoman/core/strings/code-points"
import { splitWhitespace } from "@mailwoman/core/strings/unicode"

/**
 * One rendered fragment row before its provenance columns.
 */
export interface FragmentRow {
	raw: string
	tokens: string[]
	labels: string[]
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
}

/**
 * The English country name a comma-free context row appends, keyed by OpenAddresses locale country.
 */
export const FRAGMENT_COUNTRY_NAMES: Readonly<Record<string, string>> = {
	AT: "Austria",
	CH: "Switzerland",
	CZ: "Czech Republic",
	DK: "Denmark",
	ES: "Spain",
	FI: "Finland",
	HR: "Croatia",
	NL: "Netherlands",
	NO: "Norway",
	PL: "Poland",
	PT: "Portugal",
	SE: "Sweden",
	SI: "Slovenia",
	SK: "Slovakia",
	AU: "Australia",
	NZ: "New Zealand",
}

/**
 * The shortest country surface a row ends in, so a tail is `USA` or `United States`,
 * never the bare `US` that also reads as a state code.
 */
const MIN_COUNTRY_SURFACE_CHARS = 3

/**
 * Each country's word-form surfaces in the codex's order: its curated forms,
 * or its ISO English name, keeping those of at least three characters.
 * A country left with none is absent.
 */
export function codexCountrySurfaces(): Map<string, string[]> {
	const all = new Map<string, string[]>(
		Object.entries(COUNTRY_SURFACE_FORMS).map(([iso2, forms]) => [iso2, [...forms]])
	)

	for (const [iso2, name] of ISO2_TO_NAME) {
		if (!all.has(iso2)) {
			all.set(iso2, [name])
		}
	}

	return new Map(
		[...all]
			.map(
				([iso2, forms]) => [iso2, forms.filter((form) => codePointLength(form) >= MIN_COUNTRY_SURFACE_CHARS)] as const
			)
			.filter(([, forms]) => forms.length)
	)
}

/**
 * A row assembled field by field: tokens and labels per field, spans by a code-point cursor.
 */
class FieldRow {
	tokens: string[] = []
	labels: string[] = []
	starts: number[] = []
	ends: number[] = []
	tags: string[] = []
	cursor = 0

	/**
	 * Appends a field.
	 *
	 * A `whole` field is one token for any word count.
	 * The Python renderers appended a house number or postcode.
	 */
	field(tag: string, text: string, whole = false): void {
		const words = whole ? [text] : splitWhitespace(text)

		this.tokens.push(...words)
		this.labels.push(...words.map((_, index) => (index ? `I-${tag}` : `B-${tag}`)))
		this.starts.push(this.cursor)
		this.cursor += codePointLength(text)
		this.ends.push(this.cursor)
		this.tags.push(tag)
	}

	skip(text: string): void {
		this.cursor += codePointLength(text)
	}

	row(raw: string): FragmentRow {
		return {
			raw,
			tokens: this.tokens,
			labels: this.labels,
			span_starts: this.starts,
			span_ends: this.ends,
			span_tags: this.tags,
		}
	}
}

/**
 * A bare surface, or a surface and a trailing house number, under `tag`.
 */
export function renderFragment(surface: string, number: string | null, tag = "street"): FragmentRow {
	const row = new FieldRow()

	row.field(tag, surface)

	if (!number) return row.row(surface)

	row.skip(" ")
	row.field("house_number", number, true)

	return row.row(`${surface} ${number}`)
}

/**
 * A locality and a trailing postcode: `Eight Mile Plains 4113`.
 */
export function renderLocalityPostcode(city: string, postcode: string): FragmentRow {
	const row = new FieldRow()

	row.field("locality", city)
	row.skip(" ")
	row.field("postcode", postcode, true)

	return row.row(`${city} ${postcode}`)
}

/**
 * A comma-free context row: `STREET NUMBER CITY [COUNTRY]` when the number trails,
 * else `NUMBER STREET CITY [COUNTRY]`.
 *
 * @throws When `withCountry` is set and {@linkcode FRAGMENT_COUNTRY_NAMES} has no name for `country`.
 */
export function renderContext(
	street: string,
	number: string,
	city: string,
	country: string,
	trailing: boolean,
	withCountry: boolean
): FragmentRow {
	const parts: [string, string][] = trailing
		? [
				["street", street],
				["house_number", number],
				["locality", city],
			]
		: [
				["house_number", number],
				["street", street],
				["locality", city],
			]

	if (withCountry) {
		const name = FRAGMENT_COUNTRY_NAMES[country]

		if (!name) throw new Error(`no English country name for ${country}`)

		parts.push(["country", name])
	}

	const row = new FieldRow()

	for (const [index, [tag, text]] of parts.entries()) {
		if (index) {
			row.skip(" ")
		}

		row.field(tag, text)
	}

	return row.row(parts.map(([, text]) => text).join(" "))
}

/**
 * A compact unit row: `UNIT 711 139 BOUVERIE STREET`.
 */
export function renderCompactUnit(unit: string, number: string, street: string): FragmentRow {
	const row = new FieldRow()

	row.field("unit", unit)
	row.skip(" ")
	row.field("house_number", number, true)
	row.skip(" ")
	row.field("street", street)

	return row.row(`${unit} ${number} ${street}`)
}

/**
 * A comma-free `LOCALITY REGION` pair.
 */
export function renderLocalityRegion(locality: string, region: string): FragmentRow {
	const row = new FieldRow()

	row.field("locality", locality)
	row.skip(" ")
	row.field("region", region)

	return row.row(`${locality} ${region}`)
}

/**
 * A full address ending in a country surface.
 *
 * The number and street are one group, and the groups are joined by `, `
 * when `comma` is set, else by a space.
 */
export function renderCountryContext(
	street: string,
	number: string,
	city: string,
	countryName: string,
	trailing: boolean,
	comma: boolean
): FragmentRow {
	const groups: [string, string][][] = [
		trailing
			? [
					["street", street],
					["house_number", number],
				]
			: [
					["house_number", number],
					["street", street],
				],
		[["locality", city]],
		[["country", countryName]],
	]

	const separator = comma ? ", " : " "
	const row = new FieldRow()

	for (const [groupIndex, group] of groups.entries()) {
		if (groupIndex) {
			row.skip(separator)
		}

		for (const [index, [tag, text]] of group.entries()) {
			if (index) {
				row.skip(" ")
			}

			row.field(tag, text)
		}
	}

	return row.row(groups.map((group) => group.map(([, text]) => text).join(" ")).join(separator))
}

/**
 * A leading-country admin row: `United States of America, Wyoming, Лорейн`.
 */
export function renderCountryLeading(surface: string, region: string, locality: string): FragmentRow {
	const fields: [string, string][] = [
		["country", surface],
		["region", region],
		["locality", locality],
	]

	const row = new FieldRow()

	for (const [index, [tag, text]] of fields.entries()) {
		if (index) {
			row.skip(", ")
		}

		row.field(tag, text)
	}

	return row.row(fields.map(([, text]) => text).join(", "))
}
