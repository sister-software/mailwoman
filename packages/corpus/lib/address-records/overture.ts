// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Emits Overture's address theme as address records for the address layer's key tables.
 */

import { AddressNameForm, collectAddressNames, type AddressRecord } from "@mailwoman/resolver-wof-sqlite/address/record"
import {
	canonicalizeRouteKey,
	normalizeHouseNumberForKey,
	normalizeStreetForKeyLocale,
	type StreetLocale,
} from "@mailwoman/resolver-wof-sqlite/street/normalize"
import type { PathBuilderLike } from "path-ts"

import type { UnitSplitter } from "#adapters/street/unit"
import { bareMunicipalityName } from "#address-records/legal-forms"
import { openParquetRowStream } from "#parquet/streams"

/**
 * One Overture address row, limited to the columns the adapter reads.
 */
export interface OvertureAddressRow {
	id: string
	country: string | null
	postcode: string | null
	street: string | null
	number: string | null
	unit: string | null
	address_levels: Array<{ value: string | null }> | null
	postal_city: string | null
	sources: Array<{ dataset: string | null; record_id: string | null }> | null
	lon: number | null
	lat: number | null
}

const COLUMNS = [
	"id",
	"country",
	"postcode",
	"street",
	"number",
	"unit",
	"address_levels",
	"postal_city",
	"sources",
	"lon",
	"lat",
] as const satisfies ReadonlyArray<keyof OvertureAddressRow>

/**
 * The address record for one Overture row, or `null` when the row lacks a number,
 * a street, a country or a position.
 *
 * The source id is `overture:<dataset>` of the row's first source, the id today's address-point
 * builder writes and `packages/corpus/data/us-situs-sources.json` maps to register rows.
 * The first address level is the region and the second the locality, with the bare form beside it.
 *
 * `postal_city` is the postal locality.
 * A two-letter first level is read as the subdivision code, as Overture writes US states (`WI`).
 *
 * A row whose unit is empty and whose street ends in a unit (`FRUITVALE AV U 121`) has
 * that unit split off, so the street key matches the same building's key in other sources.
 *
 * @param streetLocale The locale the street and number keys are folded under.
 * @param units Splits a trailing unit off the street.
 * Without it the street is kept as written.
 */
export function overtureAddressRecord(
	row: OvertureAddressRow,
	streetLocale: StreetLocale,
	units?: UnitSplitter
): AddressRecord | null {
	const country = row.country?.trim().toUpperCase()
	const written = row.street?.trim()
	const stated = row.unit?.trim()
	const postcode = row.postcode?.trim()
	const number = row.number?.trim() ? normalizeHouseNumberForKey(row.number, streetLocale) : null
	const source = row.sources?.[0]

	const split =
		country && written && !stated && units ? units.split(written, { country, ...(postcode ? { postcode } : {}) }) : null

	const street = split?.street ?? written

	if (!country || !street || !number || !source?.dataset) return null

	if (typeof row.lat !== "number" || typeof row.lon !== "number") return null

	const streetKey = normalizeStreetForKeyLocale(street, streetLocale)

	if (!streetKey) return null

	const { names, add } = collectAddressNames()

	const region = row.address_levels?.[0]?.value?.trim()
	const locality = row.address_levels?.[1]?.value?.trim()

	add("region", AddressNameForm.Written, region)
	add("locality", AddressNameForm.Written, locality)
	add("locality", AddressNameForm.Bare, locality ? bareMunicipalityName(locality, country) : null)
	add("locality", AddressNameForm.Postal, row.postal_city)

	return {
		source: `overture:${source.dataset}`,
		sourceRecordID: source.record_id?.trim() || row.id,
		country,
		subdivision: region && /^[A-Z]{2}$/u.test(region) ? `${country}-${region}` : null,
		number,
		unit: stated || split?.unit || null,
		streetRaw: street,
		streetKey,
		routeKey: canonicalizeRouteKey(streetKey),
		postcode: postcode || null,
		names,
		adminCode: null,
		lat: row.lat,
		lon: row.lon,
		placement: null,
		authority: null,
	}
}

/**
 * Streams the address records of an Overture address Parquet file or files,
 * skipping rows the record refuses.
 *
 * @param where A DuckDB condition rows must satisfy, such as `address_levels[1].value = 'FL'`,
 * built with `escapeSQLString`.
 * @param units Splits a trailing unit off each street, as {@link overtureAddressRecord} describes.
 */
export async function* readOvertureAddressRecords(
	parquetPath: PathBuilderLike | readonly PathBuilderLike[],
	options: { where?: string; streetLocale: StreetLocale; units?: UnitSplitter }
): AsyncGenerator<AddressRecord> {
	const rows = openParquetRowStream<OvertureAddressRow>(parquetPath, {
		columns: COLUMNS,
		...(options.where ? { where: options.where } : {}),
	})

	for await (const row of rows) {
		const record = overtureAddressRecord(row, options.streetLocale, options.units)

		if (record) {
			yield record
		}
	}
}
