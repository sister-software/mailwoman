/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Airport record retrieval and the located-in-country relation over the `iata-airport-records` artifact.
 */

import { iataAirportRecordsArtifact } from "#artifacts/iata-airport/records"
import { CODE_LENGTH_3, decode2, decode3, encode2, encode3 } from "#key"
import { Artifact } from "#rgy1/reader"
import { ColumnView, IDTableView, RelationView, StringPoolView } from "#rgy1/views"
import {
	type AirportCountryStatus,
	AirportCountryStatus as AirportCountryStatuses,
	type AirportRecord,
	type IATA,
	type ICAO,
} from "#types"

/**
 * The value the country key column holds for an airport with an extension
 * or unstated country, as the compiler's `NO_KEY` writes it.
 */
const ABSENT_KEY = 0xff_ff

interface Tables {
	artifact: Artifact
	iata: IDTableView
	columns: ColumnView[]
	pool: StringPoolView
	locatedIn: RelationView
	facilities: readonly string[]
	records: Array<AirportRecord | undefined>
}

let tables: Tables | null = null

/**
 * The column order the compiler writes.
 * `header.columns` states the same order.
 */
const COLUMN = {
	iataKey: 0,
	countryAlpha2Key: 1,
	countryStatus: 2,
	countryText: 3,
	facility: 4,
	scheduledService: 5,
	latitude: 6,
	longitude: 7,
	name: 8,
	icao: 9,
	municipality: 10,
	isoRegion: 11,
	entityID: 12,
} as const

const COUNTRY_STATUSES: readonly AirportCountryStatus[] = [
	AirportCountryStatuses.ISO3166_1,
	AirportCountryStatuses.SourceExtension,
	AirportCountryStatuses.Unstated,
]

function openAirportTables(): Tables {
	if (tables) return tables

	const artifact = Artifact.parse(iataAirportRecordsArtifact())
	const facilityColumn = artifact.header.columns?.[COLUMN.facility]

	tables = {
		artifact,
		iata: IDTableView.of(artifact, CODE_LENGTH_3),
		columns: Object.values(COLUMN).map((index) => ColumnView.of(artifact, index)),
		pool: StringPoolView.of(artifact),
		locatedIn: RelationView.of(artifact, 0),
		facilities: facilityColumn?.values ?? [],
		records: new Array<AirportRecord | undefined>(artifact.header.rows ?? 0),
	}

	return tables
}

/**
 * The record at `row`, materialized once.
 */
export function airportRecordAt(row: number): AirportRecord | null {
	const tables_ = openAirportTables()

	if (row < 0 || row >= tables_.records.length) return null

	let record = tables_.records[row]

	if (!record) {
		const { columns, pool } = tables_
		const cell = (column: number): number => columns[column]!.integer(row)
		const text = (column: number): string | null => pool.get(cell(column)) || null
		const icao = text(COLUMN.icao)

		record = Object.freeze({
			entityID: text(COLUMN.entityID) ?? "",
			iata: decode3(cell(COLUMN.iataKey)) as IATA.AirportCode,
			icao: icao as ICAO.LocationIndicator | null,
			name: text(COLUMN.name) ?? "",
			facility: tables_.facilities[cell(COLUMN.facility)] ?? "unstated",
			scheduledService: cell(COLUMN.scheduledService) === 1,
			latitude: columns[COLUMN.latitude]!.double(row),
			longitude: columns[COLUMN.longitude]!.double(row),
			country: text(COLUMN.countryText),
			countryStatus: COUNTRY_STATUSES[cell(COLUMN.countryStatus)] ?? AirportCountryStatuses.Unstated,
			municipality: text(COLUMN.municipality),
			isoRegion: text(COLUMN.isoRegion),
		})

		tables_.records[row] = record
	}

	return record
}

/**
 * The airport holding an IATA code in its canonical spelling, or `null`.
 */
export function getAirportByIATA(code: string): AirportRecord | null {
	return airportRecordAt(openAirportTables().iata.get(encode3(code)))
}

/**
 * The row of the airport holding a code, or `-1`.
 */
export function airportRowByIATA(code: string): number {
	return openAirportTables().iata.get(encode3(code))
}

/**
 * The airports the source places in a country, by its alpha-2 code, as records.
 *
 * An airport whose country is a source extension or unstated is in no country's list.
 */
export function airportsInCountry(alpha2: string): AirportRecord[] {
	return openAirportTables()
		.locatedIn.targets(encode2(alpha2))
		.map((row) => airportRecordAt(row)!)
}

/**
 * Writes the airport rows of a country into `out`; returns the count, or `-1` when `out` is too small.
 */
export function fillCountryAirports(alpha2: string, out: Uint32Array): number {
	return openAirportTables().locatedIn.targetsInto(encode2(alpha2), out)
}

/**
 * The alpha-2 code the source places an airport row in, or `null` when it is an extension or unstated.
 */
export function airportCountryAlpha2(row: number): string | null {
	const key = openAirportTables().columns[COLUMN.countryAlpha2Key]!.integer(row)

	return key === ABSENT_KEY || key === -1 ? null : decode2(key)
}

/**
 * The number of airport records.
 */
export function airportRecordCount(): number {
	return openAirportTables().records.length
}

/**
 * The records artifact's header: profile, sources, kinds and coverage.
 */
export function airportRecordsHeader(): Artifact["header"] {
	return openAirportTables().artifact.header
}
