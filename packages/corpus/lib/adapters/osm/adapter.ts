/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `osm`: OpenStreetMap address adapter (#733) for the countries no permissive source covers. Overture's addresses
 *   theme has no rows for Pakistan, Bangladesh or Vietnam (the three parquets are 532-byte headers), and the Latin
 *   model has never seen their formats: the Islamabad sector line, the Dhaka trailing postcode, the `Đường`-led street.
 *
 *   This adapter consumes the per-country JSONL `@mailwoman/osm`'s `emit-corpus-jsonl` script writes from a Geofabrik
 *   extract (`{ street, number, postcode?, suburb?, city?, unit?, place?, subdistrict?, district?, province?, lat, lon
 *   }`), the same split the `overture` adapter rides so the corpus package never meets GDAL or a PBF.
 *
 *   ⚠ ODbL. Every row carries `license: "ODbL-1.0"`, which `SHARE_ALIKE_PATTERN` matches: a proprietary-weights build
 *   passes `--exclude-share-alike` and drops these rows at ingest, so they reach the open weights only. That is the
 *   whole licensing contract of this adapter, and the reason `defaultLicense` is not an option.
 *
 *   The mapping keeps to what a person types on the envelope. Mappers put free text in `addr:housenumber` (`House 34,
 *   Road 4, Sector 9`, `Near Askari Towers 2`) and in `addr:street`; a house number is kept only in a designator shape,
 *   and a street with a comma or more than eight words is skipped as a line rather than a name. `addr:city` in
 *   Bangladesh often carries the neighborhood too (`Mirpur 10, Dhaka`): the last comma-separated part is the locality
 *   and the head becomes the dependent locality when no `addr:suburb` names one. `addr:district` is NOT mapped on its
 *   own: for Vietnam it is the quận below the city, which the country template renders only when no city is present,
 *   so a mapped district with a city would be a component with no span to align to and the row would quarantine.
 *
 *   | JSONL field                                | ComponentTag                                              |
 *   | ------------------------------------------ | --------------------------------------------------------- |
 *   | `number`                                   | `house_number` when designator-shaped (`12`, `14/E`, `B-77`) |
 *   | `street`                                   | `street` (keyword included; affix-relabel splits it)      |
 *   | `unit`                                     | `unit`                                                     |
 *   | `postcode`                                 | `postcode` when 4–6 digits                                 |
 *   | `city` (tail after the last comma)         | `locality`                                                 |
 *   | `suburb` ?? `subdistrict` ?? `district` ?? `place` ?? city head | `dependent_locality`                          |
 *   | `province`                                 | `region`, unless it repeats the locality                   |
 */

import { formatAddressRow } from "@mailwoman/codex/address-format"
import { tryParsingJSON } from "@mailwoman/core/json"
import { stripCombiningMarks } from "@mailwoman/normalize/fold"
import { TextSpliterator } from "spliterator"

import { stableSourceID } from "#adapters/utils"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "#types"

/**
 * Registry id for this adapter, stamped into every row it emits.
 */
export const OSM_ADAPTER_ID = "osm"

/**
 * OpenStreetMap's license. Share-alike: `SHARE_ALIKE_PATTERN` matches it, and `--exclude-share-alike` drops the rows.
 */
export const OSM_LICENSE = "ODbL-1.0"

/**
 * The per-row shape `@mailwoman/osm`'s `emit-corpus-jsonl` writes.
 */
interface OSMCorpusRow {
	street?: string
	number?: string
	postcode?: string
	suburb?: string
	city?: string
	unit?: string
	place?: string
	subdistrict?: string
	district?: string
	province?: string
}

/**
 * A street value that is a name rather than a mapper's whole address line.
 */
const MAX_STREET_WORDS = 8

/**
 * Whether `addr:housenumber` holds a designator a person writes after or before the street: digits with an optional
 * letter, fraction or dash suffix (`12`, `188a`, `14/E`, `1/1146`, `167-c`), or a one- or two-letter block prefix
 * (`B-77`, `L58`, `R 948`, Karachi's plot numbering). `House 34, Road 4, Sector 9`, `Plot #27`, `-` and a name are
 * not.
 */
export function housenumberIsDesignator(value: string): boolean {
	const trimmed = value.trim()

	return /^\d+[A-Za-z]?(?:[/-]\d*[A-Za-z]?)?$/u.test(trimmed) || /^[A-Za-z]{1,2}[-\s]?\d+[A-Za-z]?$/u.test(trimmed)
}

/**
 * Whether `addr:street` is a street name: no comma, at most {@link MAX_STREET_WORDS} words, and not a direction (`Near
 * Cozy Water Park`, `Opposite Askari Towers`, `Behind …`).
 */
export function isStreetName(value: string): boolean {
	const trimmed = value.trim()

	return (
		trimmed.length > 0 &&
		!trimmed.includes(",") &&
		trimmed.split(/\s+/u).length <= MAX_STREET_WORDS &&
		!/^(?:near|opp(?:osite)?|behind|beside|next to|adjacent)\b/iu.test(trimmed)
	)
}

/**
 * Split an `addr:city` that carries a neighborhood ahead of the city (`Mirpur 10, Dhaka` → locality `Dhaka`, head
 * `Mirpur 10`). A value without a comma is the locality alone.
 */
export function splitCityValue(value: string): { locality: string; head: string | null } {
	const parts = value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)

	if (parts.length < 2) return { locality: value.trim(), head: null }

	return { locality: parts.at(-1)!, head: parts.slice(0, -1).join(", ") }
}

/**
 * Values mappers write for "none".
 */
const PLACEHOLDERS = new Set(["n/a", "na", "none", "-", "nil"])

function clean(value: string | undefined): string | null {
	const trimmed = value?.trim() ?? ""

	return trimmed && !PLACEHOLDERS.has(trimmed.toLowerCase()) ? trimmed : null
}

function parseLine(line: string): OSMCorpusRow | null {
	const trimmed = line.trim()

	if (!trimmed || trimmed.startsWith("#")) return null

	const parsed = tryParsingJSON(trimmed)

	return parsed && typeof parsed === "object" ? (parsed as OSMCorpusRow) : null
}

/**
 * Map one JSONL row onto the components the corpus asserts, or null when the row has no usable street.
 */
export function componentsForOSMRow(row: OSMCorpusRow): CanonicalRow["components"] | null {
	const street = clean(row.street)

	if (!street || !isStreetName(street)) return null

	const components: CanonicalRow["components"] = { street }
	const number = clean(row.number)

	if (number && housenumberIsDesignator(number)) {
		components.house_number = number
	}

	const unit = clean(row.unit)

	if (unit) {
		components.unit = unit
	}

	const postcode = clean(row.postcode)

	if (postcode && /^\d{4,6}$/u.test(postcode)) {
		components.postcode = postcode
	}

	const city = clean(row.city)
	const split = city ? splitCityValue(city) : null

	if (split) {
		components.locality = split.locality
	}

	// The first candidate that is a name of its own: not a comma-joined pair, not the street or the locality again.
	const dependent = [row.suburb, row.subdistrict, row.district, row.place, split?.head]
		.map((value) => clean(value ?? undefined))
		.find(
			(value) =>
				value !== null &&
				!value.includes(",") &&
				!sameName(value, street) &&
				(split === null || !sameName(value, split.locality))
		)

	if (dependent) {
		components.dependent_locality = dependent
	}

	const province = clean(row.province)

	if (province && (split === null || !sameName(province, split.locality))) {
		components.region = province
	}

	// A street alone is not an address row; the coarse adapters already teach bare names. A number and a street is one:
	// 41,000 of Vietnam's 70,069 rows carry nothing above the street, and `568 Đường Điện Biên Phủ` is the line a
	// person types.
	if (Object.keys(components).length === 1) return null

	return components
}

/**
 * The admin-generic prefixes a mapper puts in front of a Vietnamese place name (`Thành phố Hà Nội`, `Tỉnh Bắc Ninh`,
 * `TP. Hồ Chí Minh`), compared away so a province that repeats the city is read as the repeat it is.
 */
const NAME_PREFIXES = /^(?:thanh pho|tinh|tp\.?|quan|phuong|huyen|thi xa)\s+/u

/**
 * Whether two place names are the same name: case, whitespace, diacritics and a leading admin generic folded (`Bắc
 * Ninh` = `Bac Ninh`; `Hà Nội` = `Thành phố Hà Nội`).
 */
export function sameName(a: string, b: string): boolean {
	const fold = (value: string): string =>
		stripCombiningMarks(value)
			.replaceAll("đ", "d")
			.replaceAll("Đ", "D")
			.toLowerCase()
			.replaceAll(/\s+/gu, " ")
			.trim()
			.replace(NAME_PREFIXES, "")

	return fold(a) === fold(b)
}

export function createOSMAdapter(): CorpusAdapter {
	return {
		id: OSM_ADAPTER_ID,
		defaultLicense: OSM_LICENSE,
		description:
			"OpenStreetMap addresses (ODbL, share-alike): per-country JSONL from a Geofabrik extract, for the countries no permissive source covers.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (!opts.country) {
				throw new Error("osm adapter: --country is required (the JSONL is per-country and rows omit a country field)")
			}

			const country = opts.country
			let emitted = 0

			for await (const line of TextSpliterator.fromAsync(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const row = parseLine(line)

				if (!row) continue

				const components = componentsForOSMRow(row)

				if (!components) continue

				const rendered = formatAddressRow(components, country, { singleLine: true })

				if (!rendered) continue

				const { raw, components: aligned } = rendered

				yield {
					raw,
					components: aligned,
					country,
					source: OSM_ADAPTER_ID,
					source_id: stableSourceID(OSM_ADAPTER_ID, aligned),
					corpus_version: "",
					license: OSM_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const osmAdapter = createOSMAdapter()
