/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Emits an OpenAddresses per-source run as address records for the address layer's key tables.
 */

import {
	AddressNameForm,
	type AddressName,
	type AddressNameLevel,
	type AddressRecord,
} from "@mailwoman/resolver-wof-sqlite/address/record"
import {
	canonicalizeRouteKey,
	normalizeHouseNumberForKey,
	normalizeLocalityForKey,
	normalizeStreetForKeyLocale,
	type StreetLocale,
} from "@mailwoman/resolver-wof-sqlite/street/normalize"
import type { PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"

import { rawTextDiscriminator } from "#adapters/record-id"
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
 * @throws When the path's first segment is not two letters.
 */
export function openAddressesRunCountry(member: string): string {
	const segment = member.split("/")[0] ?? ""

	if (!/^[a-z]{2}$/iu.test(segment)) {
		throw new Error(`OpenAddresses member ${member} does not open with a country code`)
	}

	return segment.toUpperCase()
}

/**
 * The address record for one run row, or `null` when the row lacks a number, a street or a position.
 *
 * `CITY` becomes a written locality with its bare form beside it, `REGION` the region,
 * and `DISTRICT` the subregion, since US runs fill it with a county or borough.
 * The publisher's `ID`, then the run's `HASH`, identifies the point, and a row with
 * neither takes a digest of its number, street and position.
 *
 * @param streetLocale The locale the street and house number keys are folded under.
 * The address layer's reader must fold a query for this country under the same locale.
 */
export function openAddressesAddressRecord(
	row: OpenAddressesRunRecord,
	member: string,
	streetLocale: StreetLocale
): AddressRecord | null {
	const country = openAddressesRunCountry(member)
	const number = row.number?.trim() ? normalizeHouseNumberForKey(row.number, streetLocale) : null
	const street = row.street?.trim()
	const lat = row.lat?.trim() ? Number(row.lat) : Number.NaN
	const lon = row.lon?.trim() ? Number(row.lon) : Number.NaN

	if (!number || !street || !Number.isFinite(lat) || !Number.isFinite(lon)) return null

	const streetKey = normalizeStreetForKeyLocale(street, streetLocale)

	if (!streetKey) return null

	const names: AddressName[] = []

	const add = (level: AddressNameLevel, form: AddressNameForm, value: string | null | undefined) => {
		const trimmed = value?.trim()

		if (!trimmed) return
		const key = normalizeLocalityForKey(trimmed)

		if (key && !names.some((name) => name.level === level && name.key === key)) {
			names.push({ level, form, value: trimmed, key })
		}
	}

	add("region", AddressNameForm.Written, row.region)
	add("subregion", AddressNameForm.Written, row.district)
	add("locality", AddressNameForm.Written, row.city)
	add("locality", AddressNameForm.Bare, row.city ? bareMunicipalityName(row.city.trim(), country) : null)

	return {
		source: `openaddresses:${member}`,
		sourceRecordID:
			row.id?.trim() || row.hash?.trim() || `digest:${rawTextDiscriminator(`${number} ${street} ${lat},${lon}`)}`,
		country,
		number,
		unit: row.unit?.trim() || null,
		streetRaw: street,
		streetKey,
		routeKey: canonicalizeRouteKey(streetKey),
		postcode: row.postcode?.trim() || null,
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
 */
export async function* readOpenAddressesRunRecords(
	csvPath: PathBuilderLike,
	member: string,
	streetLocale: StreetLocale
): AsyncGenerator<AddressRecord> {
	const rows = CSVSpliterator.fromAsync<OpenAddressesRunRecord>(csvPath.toString(), { normalizeKeys: true })

	for await (const row of rows) {
		const record = openAddressesAddressRecord(row, member, streetLocale)

		if (record) {
			yield record
		}
	}
}
