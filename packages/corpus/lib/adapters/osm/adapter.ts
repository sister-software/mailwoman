/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `osm`: OpenStreetMap address adapter for the countries no permissive source covers; every row carries
 * `ODbL-1.0`, which `SHARE_ALIKE_PATTERN` matches, so a proprietary-weights build drops these rows at
 * ingest and they reach only the open weights — the reason `defaultLicense` is not an option.
 */

import { formatAddressRow } from "@mailwoman/codex/address-format"
import { tryParsingJSON } from "@mailwoman/core/json"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { stripCombiningMarks } from "@mailwoman/normalize/fold"
import { TextSpliterator } from "spliterator"

import { stableSourceID } from "#adapters/utils"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter, stamped into every row it emits.
 */
export const OSM_ADAPTER_ID = "osm"

/**
 * OpenStreetMap's license; `SHARE_ALIKE_PATTERN` matches it, so `--exclude-share-alike` drops these rows.
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

const MAX_STREET_WORDS = 8

/**
 * Whether `addr:housenumber` holds a street designator — digits with an optional letter,
 * fraction or dash suffix (`12`, `188a`, `14/E`, `1/1146`, `167-c`) or a one-
 * or two-letter block prefix (`B-77`, `L58`, `R 948`) — rather than free text such
 * as `House 34, Road 4, Sector 9`, `Plot #27` or a name.
 */
export function housenumberIsDesignator(value: string): boolean {
	const trimmed = value.trim()

	return /^\d+[A-Za-z]?(?:[/-]\d*[A-Za-z]?)?$/u.test(trimmed) || /^[A-Za-z]{1,2}[-\s]?\d+[A-Za-z]?$/u.test(trimmed)
}

/**
 * Whether `addr:street` is a street name: no comma, at most {@link MAX_STREET_WORDS} words,
 * and not a direction (`Near Cozy Water Park`, `Opposite Askari Towers`, `Behind …`).
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
 * Split an `addr:city` carrying a neighborhood ahead of the city (`Mirpur 10, Dhaka` →
 * locality `Dhaka`, head `Mirpur 10`); a value without a comma is the locality alone.
 */
export function splitCityValue(value: string): { locality: string; head: string | null } {
	const parts = extractDelimited(value)

	if (parts.length < 2) {
		return { locality: value.trim(), head: null }
	}

	return { locality: parts.at(-1)!, head: parts.slice(0, -1).join(", ") }
}

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
 * Map one jsonl row onto the components the corpus asserts, or null when the row has no usable street.
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

	// Dependent-locality candidates in priority order (suburb, subdistrict, district, place, city head);
	// `district` never becomes `region`, because Vietnam's country template
	// renders it only when no city is present.
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

	// A street alone is not an address row: 41,000 of Vietnam's 70,069 rows carry no
	// component above the street, and the coarse adapters already teach bare names.
	if (Object.keys(components).length === 1) return null

	return components
}

/**
 * Vietnamese admin-generic prefixes stripped before name comparison, so a province that
 * repeats the city with a prefix (`Thành phố Hà Nội`) is read as the repeat it is.
 */
const NAME_PREFIXES = /^(?:thanh pho|tinh|tp\.?|quan|phuong|huyen|thi xa)\s+/u

/**
 * Whether two place names are the same name: case, whitespace, diacritics and a leading
 * admin generic folded (`Bắc Ninh` = `Bac Ninh`; `Hà Nội` = `Thành phố Hà Nội`).
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
		addressRole: AddressRole.Premise,
		register: SourceRegister.OpenStreetMap,
		surface: SurfaceOrigin.Attested,
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
