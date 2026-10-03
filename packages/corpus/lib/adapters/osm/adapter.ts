/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `osm`: OpenStreetMap address adapter for the countries no permissive source covers.
 *
 * Every row lists `ODbL-1.0`, whose recorded obligations include share-alike. A build run under
 * `LicensePolicy.ShareAlikeFree` refuses these rows at ingest, so they reach only the open weights.
 * That is why `defaultLicense` is not an option on this adapter.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { tryParsingJSON } from "@mailwoman/core/json"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { stripCombiningMarks } from "@mailwoman/normalize/fold"
import { TextSpliterator } from "spliterator"

import { stableSourceID } from "#adapters/source-id"
import { SourceRegister } from "#registers"
import {
	AddressRole,
	type AdapterOptions,
	type CanonicalRow,
	type CorpusAdapter,
	countDropped,
	SurfaceOrigin,
} from "#types"

/**
 * Registry id for this adapter, stamped into every row it emits.
 */
export const OSM_ADAPTER_ID = "osm"

/**
 * OpenStreetMap's license.
 *
 * Its recorded obligations include share-alike, so a build run under
 * `LicensePolicy.ShareAlikeFree` refuses every row carrying it.
 */
export const OSM_LICENSE = "ODbL-1.0"

/**
 * The URL of the ODbL license text.
 */
export const OSM_LICENSE_URL = "https://opendatacommons.org/licenses/odbl/1-0/"

/**
 * The attribution OSM requires in redistributed data and derived works.
 *
 * A database built from OSM embeds it, and a model card carries it when OSM-derived
 * rows reached the checkpoint, which the effective training manifest records.
 */
export const OSM_ATTRIBUTION =
	"© OpenStreetMap contributors. Data licensed under the Open Database License (ODbL) 1.0 " +
	`(${OSM_LICENSE_URL}); see https://www.openstreetmap.org/copyright.`

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
	country?: string
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
 * Whether `addr:street` matches the street-name shape.
 *
 * The value has no comma and contains at most {@link MAX_STREET_WORDS} words.
 * Direction phrases such as `Near Cozy Water Park`, `Opposite Askari Towers` or `Behind …` return false.
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
 * locality `Dhaka`, head `Mirpur 10`); a value without a comma is only the locality.
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
 * Maps one jsonl row onto the components the corpus asserts, or returns null when the row is refused.
 *
 * A row with a street-shaped `addr:street` is a street address.
 * A row with no `addr:street` at all is admitted as a streetless premise when its house
 * number is designator-shaped and a tag that maps to `locality` or `dependent_locality`
 * (`addr:city`, `addr:place`, `addr:suburb`, `addr:subdistrict`, `addr:district`)
 * carries the identity the street would have carried.
 *
 * That is OSM's documented scheme for addresses numbered within a named place
 * rather than along a street, and it is the `streetless-premise-identity` shape.
 * A row whose `addr:street` holds a line rather than a name stays refused:
 * the mapper supplied a street, and the value is a line.
 *
 * Each refusal and each discarded component increments its reason in `dropped`.
 */
export function componentsForOSMRow(
	row: OSMCorpusRow,
	dropped?: Pick<AdapterOptions, "dropped">
): CanonicalRow["components"] | null {
	const tally = dropped ?? {}
	const street = clean(row.street)
	const number = clean(row.number)
	const designator = number !== null && housenumberIsDesignator(number)

	if (street && !isStreetName(street)) {
		countDropped(tally, "row:street-not-a-name")

		return null
	}

	if (!street && !designator) {
		countDropped(tally, number ? "row:streetless-house-number-not-designator" : "row:streetless-no-house-number")

		return null
	}

	const components: CanonicalRow["components"] = street ? { street } : {}

	if (designator) {
		components.house_number = number
	} else if (number) {
		countDropped(tally, "component:house_number:not-designator")
	}

	const unit = clean(row.unit)

	if (unit) {
		components.unit = unit
	}

	const postcode = clean(row.postcode)

	if (postcode && /^\d{4,6}$/u.test(postcode)) {
		components.postcode = postcode
	} else if (postcode) {
		countDropped(tally, "component:postcode:not-4-to-6-digits")
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
				(street === null || !sameName(value, street)) &&
				(split === null || !sameName(value, split.locality))
		)

	if (dependent) {
		components.dependent_locality = dependent
	}

	const province = clean(row.province)

	if (province && (split === null || !sameName(province, split.locality))) {
		components.region = province
	}

	// A streetless premise is a house number within a named place, so it needs a locality
	// or a dependent locality, from any of the tags that map to them.
	if (!street && !components.locality && !components.dependent_locality) {
		countDropped(tally, "row:streetless-no-locality")

		return null
	}

	// An address row needs another component alongside the street or the streetless house number.
	// Coarse adapters already teach bare names.
	if (Object.keys(components).length === 1) {
		countDropped(tally, street ? "row:street-only" : "row:house-number-only")

		return null
	}

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
		surface: SurfaceOrigin.Rendered,
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

				if (!row) {
					if (line.trim() && !line.trim().startsWith("#")) {
						countDropped(opts, "row:unparseable-line")
					}

					continue
				}

				// A Geofabrik extract's polygon extends past the border, so its records
				// include addresses in the neighboring country.
				// A record whose own `addr:country` names another country is refused.
				// A record without the tag is kept and counted, so the size of the remaining
				// uncertainty is in the manifest rather than assumed to be zero.
				const tagged = clean(row.country)?.toUpperCase()

				if (tagged && tagged !== country) {
					countDropped(opts, "row:country-tag-mismatch")

					continue
				}

				if (!tagged) {
					countDropped(opts, "kept:country-untagged")
				}

				const components = componentsForOSMRow(row, opts)

				if (!components) continue

				const rendered = formatAddressRow(components, country, { singleLine: true })

				if (!rendered) {
					countDropped(opts, "row:render-failed")

					continue
				}

				const { raw, components: aligned } = rendered

				for (const tag of rendered.unplaced) {
					countDropped(opts, `component:${tag}:not-rendered`)
				}

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
