// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Emits an OpenAddresses per-source run as address records for the address layer's key tables.
 */

import { escapeRegExp } from "@mailwoman/core/strings/regexp"
import { isPresent } from "@mailwoman/core/values/objects"
import { AddressNameForm, collectAddressNames, type AddressRecord } from "@mailwoman/resolver-wof-sqlite/address/record"
import {
	canonicalizeRouteKey,
	normalizeHouseNumberForKey,
	normalizeStreetForKeyLocale,
	type StreetLocale,
} from "@mailwoman/resolver-wof-sqlite/street/normalize"
import type { PathBuilderLike } from "path-ts"
import { CSVSpliterator, JSONSpliterator } from "spliterator"

import { rawTextDiscriminator } from "#adapters/record-id"
import type { UnitSplitter } from "#adapters/street/unit"
import { bareMunicipalityName } from "#address-records/legal-forms"

/**
 * One row of an OpenAddresses run's CSV, under the lower-case keys the CSV reader gives it.
 */
export interface OpenAddressesRunRecord {
	lon?: string
	lat?: string
	number?: string
	street?: string
	unit?: string
	city?: string
	district?: string
	region?: string
	postcode?: string
	id?: string
	hash?: string
}

/**
 * The ISO 3166-1 alpha-2 code a run's member path opens with, such as `US` for `us/wi/statewide`.
 *
 * @throws When the path's first segment isn't two letters.
 */
export function openAddressesRunCountry(member: string): string {
	const segment = member.split("/")[0] ?? ""

	if (!/^[a-z]{2}$/iu.test(segment)) {
		throw new Error(`OpenAddresses member ${member} does not open with a country code`)
	}

	return segment.toUpperCase()
}

/**
 * The ISO 3166-2 code a run's member path states, such as `US-WI` for `us/wi/statewide`, or `null`
 * when its second segment is a city or body rather than a two-letter subdivision code (`de/berlin`).
 */
export function openAddressesRunSubdivision(member: string): string | null {
	const [, segment] = member.split("/")

	return segment && /^[a-z]{2}$/iu.test(segment) ? `${openAddressesRunCountry(member)}-${segment.toUpperCase()}` : null
}

/**
 * The street with a trailing place removed when every part of that place repeats the row's
 * own fields: `CHURCH ST STERLING, CO 80751` on a row whose `CITY` is `STERLING`, `REGION`
 * (or the run's subdivision) is `CO` and `POSTCODE` is `80751` reads `CHURCH ST`.
 *
 * The place is the row's city followed by its state, its postcode, or both, in that order.
 * A trailing city with neither a state nor a postcode after it is kept,
 * because a street can end in its own town's name.
 *
 * A row with no `CITY` keeps its street, since no field states what a trailing town would repeat.
 * A street that would be left as one word shorter than three characters is kept whole.
 */
function withoutRepeatedPlace(street: string, row: OpenAddressesRunRecord, member: string): string {
	const city = row.city?.trim()

	if (!city) return street

	const subdivision = openAddressesRunSubdivision(member)?.split("-")[1]
	const states = [...new Set([row.region?.trim(), subdivision].filter(isPresent).map((state) => state.toUpperCase()))]
	const postcode = row.postcode?.trim()
	const zip = postcode ? /^(\d{5})(?:-?\d{4})?$/u.exec(postcode)?.[1] : null

	const statePart = states.length ? `[\\s,]+(?:${states.map(escapeRegExp).join("|")})\\.?` : null
	const postcodePart = postcode ? `[\\s,]+${zip ? `${zip}(?:-?\\d{4})?` : escapeRegExp(postcode)}` : null

	const tails = [statePart && (postcodePart ? `${statePart}(?:${postcodePart})?` : statePart), postcodePart].filter(
		isPresent
	)

	if (!tails.length) return street

	const place = new RegExp(`[\\s,]+${escapeRegExp(city)}(?:${tails.join("|")})\\s*$`, "iu").exec(street)

	if (!place) return street

	const remainder = street
		.slice(0, place.index)
		.replace(/[\s,-]+$/u, "")
		.trim()

	// A remainder of one word shorter than three characters, such as the `E` of `E YAKIMA WA`
	// in Yakima, means the city's name is also the street's own name.
	const lone = !/\s/u.test(remainder) && [...remainder].length < MIN_LONE_STREET_LENGTH

	return remainder && !lone ? remainder : street
}

/**
 * The fewest characters a one-word street left after the place is removed may hold.
 */
const MIN_LONE_STREET_LENGTH = 3

/**
 * The address record for one run row, or `null` when the row lacks a number, a street or a position.
 *
 * `CITY` becomes a written locality with its bare form beside it, `REGION` the region,
 * and `DISTRICT` the subregion, since US runs fill it with a county or borough.
 * The publisher's `ID`, then the run's `HASH`, identifies the point, and a row with
 * neither takes a digest of its number, street and position.
 *
 * A row whose `UNIT` is empty and whose street ends in a unit (`VERNON ST APT 114`, `COOGINS DR #106`)
 * has that unit split off, so the street key matches the same building's key in other sources.
 * Before that, a trailing city, state and postcode that repeat the row's own
 * fields are removed (`CHURCH ST STERLING, CO 80751`).
 * The digest identifier still reads the street as written.
 *
 * @param streetLocale The locale the street and house number keys are folded under.
 * The address layer's reader must fold a query for this country under the same locale.
 * @param units Splits a trailing unit off the street.
 * Without it the street is kept as written.
 */
export function openAddressesAddressRecord(
	row: OpenAddressesRunRecord,
	member: string,
	streetLocale: StreetLocale,
	units?: UnitSplitter
): AddressRecord | null {
	const country = openAddressesRunCountry(member)
	const number = row.number?.trim() ? normalizeHouseNumberForKey(row.number, streetLocale) : null
	const written = row.street?.trim()
	const placeless = written ? withoutRepeatedPlace(written, row, member) : written
	const stated = row.unit?.trim()
	const postcode = row.postcode?.trim()

	const split =
		placeless && !stated && units ? units.split(placeless, { country, ...(postcode ? { postcode } : {}) }) : null

	const street = split?.street ?? placeless
	const lat = row.lat?.trim() ? Number(row.lat) : Number.NaN
	const lon = row.lon?.trim() ? Number(row.lon) : Number.NaN

	if (!number || !street || !Number.isFinite(lat) || !Number.isFinite(lon)) return null

	const streetKey = normalizeStreetForKeyLocale(street, streetLocale)

	if (!streetKey) return null

	const { names, add } = collectAddressNames()

	add("region", AddressNameForm.Written, row.region)
	add("subregion", AddressNameForm.Written, row.district)
	add("locality", AddressNameForm.Written, row.city)
	add("locality", AddressNameForm.Bare, row.city ? bareMunicipalityName(row.city.trim(), country) : null)

	return {
		source: `openaddresses:${member}`,
		sourceRecordID:
			row.id?.trim() || row.hash?.trim() || `digest:${rawTextDiscriminator(`${number} ${written} ${lat},${lon}`)}`,
		country,
		subdivision: openAddressesRunSubdivision(member),
		number,
		unit: stated || split?.unit || null,
		streetRaw: street,
		streetKey,
		routeKey: canonicalizeRouteKey(streetKey),
		postcode: postcode || null,
		names,
		adminCode: null,
		lat,
		lon,
		placement: null,
		authority: null,
	}
}

/**
 * Streams the address records of one extracted OpenAddresses run CSV, skipping rows the record refuses.
 *
 * @param member The run's member path, such as `us/wi/statewide`, which supplies the source id and country.
 * @param streetLocale The locale {@link openAddressesAddressRecord} folds keys under.
 * @param units Splits a trailing unit off each street, as {@link openAddressesAddressRecord} describes.
 */
export async function* readOpenAddressesRunRecords(
	csvPath: PathBuilderLike,
	member: string,
	streetLocale: StreetLocale,
	units?: UnitSplitter
): AsyncGenerator<AddressRecord> {
	const rows = CSVSpliterator.fromAsync<OpenAddressesRunRecord>(csvPath.toString(), { normalizeKeys: true })

	for await (const row of rows) {
		const record = openAddressesAddressRecord(row, member, streetLocale, units)

		if (record) {
			yield record
		}
	}
}

/**
 * The file name a run's batch job output is cached under, such as `us__mi__statewide.source.geojson.gz`.
 */
export function openAddressesSourceCacheName(member: string): string {
	return `${member.replaceAll("/", "__")}.source.geojson.gz`
}

/**
 * One feature of an OpenAddresses batch job's `source.geojson.gz`: a point
 * and the run's fields in lower case.
 */
interface OpenAddressesRunFeature {
	geometry?: { type?: string; coordinates?: readonly number[] } | null
	properties?: Omit<OpenAddressesRunRecord, "lon" | "lat"> | null
}

/**
 * Streams the address records of one OpenAddresses batch job's `source.geojson.gz`,
 * as cached by `fetchOpenAddressesSources`, skipping features the record refuses.
 *
 * The reader decompresses the file as it streams, so the run is never extracted to disk.
 * A feature without a point geometry has no position, and the record refuses it.
 *
 * @param member The run's member path, such as `us/mi/statewide`, which supplies the source id and country.
 */
export async function* readOpenAddressesGeoJSONRunRecords(
	geojsonPath: PathBuilderLike,
	member: string,
	streetLocale: StreetLocale,
	units?: UnitSplitter
): AsyncGenerator<AddressRecord> {
	for await (const feature of JSONSpliterator.fromAsync<OpenAddressesRunFeature>(geojsonPath.toString())) {
		const point = feature.geometry?.type === "Point" ? feature.geometry.coordinates : null

		const row: OpenAddressesRunRecord = {
			...feature.properties,
			...(point ? { lon: String(point[0]), lat: String(point[1]) } : {}),
		}

		const record = openAddressesAddressRecord(row, member, streetLocale, units)

		if (record) {
			yield record
		}
	}
}
