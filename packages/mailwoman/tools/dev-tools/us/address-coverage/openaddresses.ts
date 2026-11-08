/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Adds OpenAddresses source runs to a state's address-point database, for the counties the census finds thin.
 *
 *   A row keeps `openaddresses:<member>` as its source, so it names its contributing body. That value is absent from
 *   the corpus's situs source table, so no training recipe reads these rows.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import {
	canonicalizeRouteKey,
	normalizeLocalityForKey,
	normalizeStreetForKeyLocale,
} from "@mailwoman/resolver-wof-sqlite/street"

/**
 * The farthest, in degrees, a street segment's vertex may lie from a point
 * whose postcode it supplies: about 1 km.
 *
 * A state can hold several streets of one name, each with its own postcode,
 * so the segment has to lie beside the point.
 */
const SEGMENT_REACH_DEGREES = 0.01

/**
 * Returns the postcode of the segment nearest a point, or null when no segment's vertex lies within reach.
 */
export function postcodeNearPoint(
	point: { lat: number; lon: number },
	segments: ReadonlyArray<{ postcode: string; geometry: string }>
): string | null {
	let best: string | null = null
	let bestDistance = SEGMENT_REACH_DEGREES

	for (const { postcode, geometry } of segments) {
		for (const [lon, lat] of parseJSONStrict<Array<[number, number]>>(geometry)) {
			const distance = Math.max(Math.abs(lat - point.lat), Math.abs(lon - point.lon))

			if (distance <= bestDistance) {
				best = postcode
				bestDistance = distance
			}
		}
	}

	return best
}

/**
 * An OpenAddresses run's CSV record, with the lower-case keys the reader gives it.
 */
export interface OpenAddressesRecord {
	lon?: string
	lat?: string
	number?: string
	street?: string
	unit?: string
	city?: string
	postcode?: string
}

/**
 * One row of the address-point table, without the optional cell column.
 */
export interface OpenAddressesRow {
	street_norm: string
	street_key: string
	number: string
	unit: string | null
	postcode: string | null
	locality_norm: string | null
	street_raw: string
	lat: number
	lon: number
	source: string
	release: string
}

/**
 * Reads a record as a table row, or null for a record with no usable street, number or coordinate.
 *
 * A postcode keeps its first five digits, because the lookup keys on the five-digit form.
 */
export function openAddressesRow(
	record: OpenAddressesRecord,
	member: string,
	release: string
): OpenAddressesRow | null {
	const lat = Number(record.lat)
	const lon = Number(record.lon)
	const number = record.number?.trim().toLowerCase()
	const street = record.street?.trim()

	if (!lat || !lon || !number || !street) return null

	const streetNorm = normalizeStreetForKeyLocale(street, "en")

	if (!streetNorm) return null

	const city = record.city?.trim()

	return {
		street_norm: streetNorm,
		street_key: canonicalizeRouteKey(streetNorm),
		number,
		unit: record.unit?.trim().toLowerCase() || null,
		postcode: /^\d{5}/u.exec(record.postcode?.trim() ?? "")?.[0] ?? null,
		locality_norm: city ? normalizeLocalityForKey(city) : null,
		street_raw: street,
		lat,
		lon,
		source: `openaddresses:${member}`,
		release,
	}
}

/**
 * The farthest apart, in degrees, two rows of one street and number count as one address: about 200 meters.
 *
 * A reporting body and NAD place the same door at different points,
 * and a namesake street lies far beyond this.
 */
const SAME_ADDRESS_DEGREES = 0.002

/**
 * Reports whether a row repeats one of the stored points of its street and number.
 */
export function repeatsStoredPoint(
	row: Pick<OpenAddressesRow, "lat" | "lon">,
	stored: ReadonlyArray<{ lat: number; lon: number }>
): boolean {
	return stored.some(
		(point) =>
			Math.abs(point.lat - row.lat) <= SAME_ADDRESS_DEGREES && Math.abs(point.lon - row.lon) <= SAME_ADDRESS_DEGREES
	)
}
