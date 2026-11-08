/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Emits the National Address Database release as address records for the address layer's key tables.
 */

import { isUSStateAbbreviation, US_TERRITORY_ABBREVIATIONS } from "@mailwoman/codex/us/state"
import { isPresent } from "@mailwoman/core/objects"
import {
	AddressNameForm,
	collectAddressNames,
	type AddressName,
	type AddressRecord,
} from "@mailwoman/resolver-wof-sqlite/address/record"
import { canonicalizeRouteKey, normalizeStreetForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import type { PathBuilderLike } from "path-ts"

import { bareMunicipalityName } from "#address-records/legal-forms"
import {
	decomposeNADStreet,
	NAD_PLACEHOLDER_UUID,
	nadHouseNumber,
	type NADRecord,
	readNADRecords,
	statedNADPlaceName,
	USGOV_NAD_ADAPTER_ID,
} from "#us/adapters/usgov/nad/adapter"

const TERRITORIES: ReadonlySet<string> = new Set(US_TERRITORY_ABBREVIATIONS)

/**
 * Every place name in a NAD record, by level, with the bare form of each written municipality beside it.
 *
 * `Inc_Muni` is the incorporated municipality, `Post_City` the postal city,
 * `Census_Plc` the census place and `Uninc_Comm` the unincorporated community.
 * All four are localities, since a writer may put any of them on a letter.
 *
 * `Nbrhd_Comm` is a neighborhood, so it is a dependent locality.
 * A pair of level and key is kept once, under the first form that produced it.
 */
export function nadAddressNames(record: NADRecord): AddressName[] {
	const { names, add } = collectAddressNames()

	const state = statedNADPlaceName(record.State)

	add("region", AddressNameForm.Written, state)
	add("subregion", AddressNameForm.Written, statedNADPlaceName(record.County))

	for (const column of [record.Inc_Muni, record.Census_Plc, record.Uninc_Comm]) {
		const written = statedNADPlaceName(column)

		add("locality", AddressNameForm.Written, written)
		add("locality", AddressNameForm.Bare, written ? bareMunicipalityName(written, "US") : null)
	}

	add("locality", AddressNameForm.Postal, statedNADPlaceName(record.Post_City))
	add("dependent_locality", AddressNameForm.Written, statedNADPlaceName(record.Nbrhd_Comm))

	return names
}

/**
 * The address record for one NAD row, or `null` when the row lacks a house number,
 * a street, a state or a finite position.
 */
export function nadAddressRecord(record: NADRecord): AddressRecord | null {
	const state = statedNADPlaceName(record.State)?.toUpperCase()
	const number = nadHouseNumber(record)?.toLowerCase()
	const street = decomposeNADStreet(record)?.full
	// `Number` reads an absent or blank coordinate as 0, a real position off West Africa.
	const coordinate = (value: string | null | undefined) => (value?.trim() ? Number(value) : Number.NaN)
	const lat = coordinate(record.Latitude)
	const lon = coordinate(record.Longitude)

	if (!isUSStateAbbreviation(state) || !number || !street || !Number.isFinite(lat) || !Number.isFinite(lon)) return null

	const streetKey = normalizeStreetForKey(street)
	const uuid = record.UUID && !NAD_PLACEHOLDER_UUID.test(record.UUID) ? record.UUID : null
	const sourceRecordID = uuid ?? (record.OID_ ? `oid:${record.OID_}` : null)

	if (!sourceRecordID) return null

	// A publisher may write one designator into several columns, as New York writes `Apartment 2`
	// into both `Building` and `Unit`, so a part that repeats an earlier one is kept once.
	const unit = [
		...new Set(
			[record.Building, record.Floor, record.Unit, record.Room].map((part) => part?.trim() || null).filter(isPresent)
		),
	].join(" ")

	return {
		source: USGOV_NAD_ADAPTER_ID,
		sourceRecordID,
		// Each territory's USPS code is also its ISO 3166-1 code, and a state's is its ISO 3166-2 suffix.
		country: TERRITORIES.has(state) ? state : "US",
		subdivision: TERRITORIES.has(state) ? null : `US-${state}`,
		number,
		unit: unit || null,
		streetRaw: street,
		streetKey,
		routeKey: canonicalizeRouteKey(streetKey),
		postcode: record.Zip_Code?.trim() || null,
		names: nadAddressNames(record),
		adminCode: null,
		lat,
		lon,
		placement: record.Placement?.trim() || null,
		authority: record.AddAuth?.trim() || null,
	}
}

/**
 * Streams the address records of one NAD release Parquet file, skipping rows
 * {@link nadAddressRecord} refuses.
 *
 * @param where A DuckDB condition rows must satisfy, such as `"State" = 'WI'`,
 * built with `escapeSQLString`.
 */
export async function* readNADAddressRecords(
	parquetPath: PathBuilderLike,
	options: { where?: string } = {}
): AsyncGenerator<AddressRecord> {
	for await (const row of readNADRecords(parquetPath, options)) {
		const record = nadAddressRecord(row)

		if (record) {
			yield record
		}
	}
}
