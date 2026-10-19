/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `opendata-az`: `Azərbaycanda obyektlər və məkanlar` (objects and places in Azerbaijan), a GeoJSON of
 * 11,807 points of interest in Baku, Sumgayit and Absheron that the Ministry of Ecology and Natural
 * Resources publishes on opendata.az.
 *
 * Each point holds a place's name (`NAME`) and its address in English transliteration: `STRT_NAME` and
 * `STRT_ADDR` for the street and number, `STATE` for the city district or settlement and `CITY` for the
 * city. The adapter reads `NAME` as the venue, `STRT_NAME` as the street, `STRT_ADDR` as the house
 * number, the last comma part of `STATE` (`Sabunchu,Zabrat` names the settlement Zabrat) as the dependent
 * locality and `CITY` as the locality. Absheron is a district rather than a city, so an Absheron row
 * takes its settlement (`Khirdalan`, `Masazir`) as the locality.
 *
 * `STRT_ADDR` writes `0` where the point has no number. Some street values carry the number after a
 * comma (`Zarifa Aliyeva,38`) or a building's name in parentheses (`Azadlig Avenue(Hilton Baku)`): the
 * number is read from the street when `STRT_ADDR` has none, and the parenthetical is removed. A block
 * code (`558-ci0mehelle030`) is not a house number. A row with neither a number nor a venue is refused.
 *
 * `NAME` names a point of interest of the type `TYPE` states (`Cafe Gorush`, `School 93`, `Library by
 * A. P. Chekhov`). No value in the 2025-08-05 file is a person's given name and surname alone: of the
 * three that read `<Word> <surname-ending>`, each is a category word and a name (`Cafe Beyzade`,
 * `Monument Rahimov`). A value with no run of three letters is a code and is dropped.
 *
 * Ninety-two points also carry their street in Azerbaijani spelling (`STRT_N_AZ`); each of those
 * emits a second row in that spelling, with `NAME_AZ`, `STATE_AZ` and `CITY_AZ` where present
 * (`Bakı` for `Baku`), when it renders differently from the first.
 *
 * The file holds no postcode. The CKAN record states `license_id: cc-by`, `Creative Commons Attribution`,
 * with no version, so the rows carry a LicenseRef rather than an SPDX id that would assert a version.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { resolvePath } from "path-ts"

import { UnsupportedCountryError } from "#adapters/errors"
import { presentCollapsed as present } from "#adapters/present"
import { stableSourceIDFromParts } from "#adapters/source-id"
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
export const OPENDATA_AZ_ADAPTER_ID = "opendata-az"

/**
 * The publisher's license, Creative Commons Attribution, whose version the record leaves unstated.
 */
export const OPENDATA_AZ_LICENSE = "LicenseRef-CC-BY-unstated-version"

/**
 * Every jurisdiction this adapter emits, checked against a caller's `--country`.
 */
export const OPENDATA_AZ_COUNTRIES: readonly string[] = ["AZ"]

/**
 * The feature properties the adapter reads.
 */
export interface AzerbaijanPlaceRecord {
	OBJECTID?: number | null
	CITY?: string | null
	STATE?: string | null
	STRT_NAME?: string | null
	STRT_ADDR?: string | null
	NAME?: string | null
	NAME_AZ?: string | null
	STATE_AZ?: string | null
	STRT_N_AZ?: string | null
	CITY_AZ?: string | null
}

interface AzerbaijanFeatureCollection {
	features?: Array<{
		properties?: AzerbaijanPlaceRecord | null
		geometry?: { coordinates?: readonly number[] } | null
	}>
}

/**
 * The spelling a row is rendered in.
 */
export const AzerbaijanSpelling = {
	/**
	 * `STRT_NAME`, `NAME`, `STATE` and `CITY`: English transliteration.
	 */
	Transliterated: "transliterated",
	/**
	 * `STRT_N_AZ`, `NAME_AZ`, `STATE_AZ` and `CITY_AZ`: Azerbaijani.
	 */
	Azerbaijani: "azerbaijani",
} as const

export type AzerbaijanSpelling = (typeof AzerbaijanSpelling)[keyof typeof AzerbaijanSpelling]

/**
 * A house number: digits with an optional letter, and an optional second number
 * after a slash, backslash or hyphen (`4/66`, `23-33`, `20\116`, `8/5A`).
 */
const HOUSE_NUMBER = /^\d+\p{L}?(?:[/\\-]\d+\p{L}?)?$/u

/**
 * A street value that carries the house number after a comma, as `Zarifa Aliyeva,38`.
 */
const STREET_WITH_NUMBER = /^(.+?),\s*(\d+\p{L}?(?:\/\d+\p{L}?)?)$/u

/**
 * A block (`məhəllə`) code in the number column, as `558-ci0mehelle030`.
 */
const BLOCK_CODE = /mehelle/iu

/**
 * The house number `STRT_ADDR` states, with a backslash read as the slash it stands for,
 * or null when the value is absent, `0`, or not a house number.
 */
function houseNumberFrom(value: string | null, tally: Pick<AdapterOptions, "dropped">): string | null {
	if (!value || value === "0") return null

	if (BLOCK_CODE.test(value)) {
		countDropped(tally, "component:house_number:block-code")

		return null
	}

	if (!HOUSE_NUMBER.test(value)) {
		countDropped(tally, "component:house_number:not-a-number")

		return null
	}

	return value.replaceAll("\\", "/")
}

/**
 * The fields of one spelling: the street, venue, district and city columns it reads.
 */
interface SpellingFields {
	street: string | null
	venue: string | null
	state: string | null
	city: string | null
}

function fieldsFor(record: AzerbaijanPlaceRecord, spelling: AzerbaijanSpelling): SpellingFields {
	if (spelling === AzerbaijanSpelling.Azerbaijani) {
		return {
			street: present(record.STRT_N_AZ),
			venue: present(record.NAME_AZ),
			state: present(record.STATE_AZ) ?? present(record.STATE),
			city: present(record.CITY_AZ) ?? present(record.CITY),
		}
	}

	return {
		street: present(record.STRT_NAME),
		venue: present(record.NAME),
		state: present(record.STATE),
		city: present(record.CITY),
	}
}

/**
 * Whether a city value is the Absheron district, in either spelling.
 */
function isAbsheron(city: string): boolean {
	return /^Ab(?:sh|ş)eron$/iu.test(city)
}

/**
 * Maps one record onto the components the corpus asserts in one spelling,
 * or returns null when the row is refused.
 *
 * Each refusal and each dropped component increments its reason in `dropped`.
 */
export function componentsForAzerbaijanRecord(
	record: AzerbaijanPlaceRecord,
	dropped?: Pick<AdapterOptions, "dropped">,
	spelling: AzerbaijanSpelling = AzerbaijanSpelling.Transliterated
): CanonicalRow["components"] | null {
	const tally = dropped ?? {}
	const fields = fieldsFor(record, spelling)
	let street = fields.street

	if (!street) {
		countDropped(tally, "row:no-street")

		return null
	}

	if (/[{@]/u.test(street)) {
		countDropped(tally, "row:street-markup")

		return null
	}

	let houseNumber = houseNumberFrom(present(record.STRT_ADDR), tally)
	const carried = STREET_WITH_NUMBER.exec(street)

	if (carried) {
		street = carried[1]!.trim()
		houseNumber ??= carried[2]!
	}

	if (/\(/u.test(street)) {
		street = street.replaceAll(/\s*\([^)]*\)\s*/gu, " ").trim()
		countDropped(tally, "component:street:parenthetical-removed")
	}

	if (!street || street.includes(",")) {
		countDropped(tally, "row:street-holds-several-parts")

		return null
	}

	const components: CanonicalRow["components"] = { street }

	if (houseNumber) {
		components.house_number = houseNumber
	}

	const venue = fields.venue

	// A value with no run of three letters (`555`, `SM`, `T T`) is a code rather than a name.
	if (venue && !/\p{L}{3}/u.test(venue)) {
		countDropped(tally, "component:venue:code")
	} else if (venue) {
		components.venue = venue
	}

	if (!components.house_number && !components.venue) {
		countDropped(tally, "row:no-house-number-or-venue")

		return null
	}

	const city = fields.city
	const district = fields.state?.split(",").pop()?.trim() || null

	if (!city) {
		countDropped(tally, "row:no-city")

		return null
	}

	if (isAbsheron(city)) {
		components.locality = district ?? city
	} else {
		components.locality = city

		if (district && district.toLowerCase() !== city.toLowerCase() && !/^Sum[gq]ayit$/iu.test(district)) {
			components.dependent_locality = district
		}
	}

	return components
}

export function createAzerbaijanPlacesAdapter(): CorpusAdapter {
	return {
		id: OPENDATA_AZ_ADAPTER_ID,
		defaultLicense: OPENDATA_AZ_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.AzerbaijanObjectsAndPlaces,
		surface: SurfaceOrigin.Rendered,
		description:
			"Azərbaycanda obyektlər və məkanlar (Ministry of Ecology and Natural Resources, opendata.az): addressed places in Baku, Sumgayit and Absheron.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !OPENDATA_AZ_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(OPENDATA_AZ_ADAPTER_ID, OPENDATA_AZ_COUNTRIES, opts.country)
			}

			// The publication is one 5 MB file, so it is parsed whole.
			const path = resolvePath(opts.inputPath)
			const collection = parseJSONStrict<AzerbaijanFeatureCollection>(await readLocalTextFile(path))

			if (!Array.isArray(collection.features)) {
				throw new TypeError(`${OPENDATA_AZ_ADAPTER_ID} adapter: ${path} holds no GeoJSON features array`)
			}

			let emitted = 0

			for (const feature of collection.features) {
				const record = feature.properties

				if (!record) {
					countDropped(opts, "row:no-properties")

					continue
				}

				const [lon, lat] = feature.geometry?.coordinates ?? []
				let transliterated: string | null = null

				const spellings = present(record.STRT_N_AZ)
					? [AzerbaijanSpelling.Transliterated, AzerbaijanSpelling.Azerbaijani]
					: [AzerbaijanSpelling.Transliterated]

				for (const spelling of spellings) {
					if (opts.signal?.aborted) return

					if (typeof opts.limit === "number" && emitted >= opts.limit) return

					// The Azerbaijani row is counted under its own prefix, so its refusals
					// do not read as refusals of records.
					const tally = spelling === AzerbaijanSpelling.Azerbaijani ? { dropped: new Map<string, number>() } : opts
					const components = componentsForAzerbaijanRecord(record, tally, spelling)

					if (spelling === AzerbaijanSpelling.Azerbaijani) {
						for (const [reason, count] of tally.dropped ?? []) {
							const key = `azerbaijani-spelling:${reason}`

							opts.dropped?.set(key, (opts.dropped.get(key) ?? 0) + count)
						}
					}

					if (!components) continue

					const rendered = formatAddressRow(components, "AZ", { singleLine: true })

					if (!rendered) {
						countDropped(opts, "row:render-failed")

						continue
					}

					for (const tag of rendered.unplaced) {
						countDropped(opts, `component:${tag}:not-rendered`)
					}

					const { raw, components: aligned } = rendered

					if (spelling === AzerbaijanSpelling.Transliterated) {
						transliterated = raw
					} else if (raw === transliterated) {
						countDropped(opts, "azerbaijani-spelling:row:renders-as-transliterated")

						continue
					}

					yield {
						raw,
						components: aligned,
						country: "AZ",
						locale: spelling === AzerbaijanSpelling.Azerbaijani ? "az-AZ" : "en-AZ",
						source: OPENDATA_AZ_ADAPTER_ID,
						// `OBJECTID` is unique per feature.
						// The spelling separates a feature's two rows.
						source_id: stableSourceIDFromParts(OPENDATA_AZ_ADAPTER_ID, {
							...aligned,
							objectid: present(record.OBJECTID) ?? "",
							spelling,
							lat: typeof lat === "number" ? String(lat) : "",
							lon: typeof lon === "number" ? String(lon) : "",
						}),
						corpus_version: "",
						license: OPENDATA_AZ_LICENSE,
					}

					emitted++
				}
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const azerbaijanPlacesAdapter = createAzerbaijanPlacesAdapter()
