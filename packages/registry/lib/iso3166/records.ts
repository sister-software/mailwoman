/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Country record retrieval over the `iso3166-1-records` artifact: three id tables, six columns and a string pool.
 *
 *   A record is materialized on request and cached by row, so a repeated read of one country returns one object. The
 *   artifact holds every status; `getCountry*` answers a record of any status and reports it, while the brands and the
 *   membership predicates cover officially assigned codes only.
 */

import { iso31661RecordsArtifact } from "#artifacts/iso3166-1/records"
import {
	ARITY_NUMERIC,
	CODE_LENGTH_2,
	CODE_LENGTH_3,
	decode2,
	decode3,
	decodeNumeric,
	encode2,
	encode3,
	encodeNumeric,
} from "#key"
import { Artifact } from "#rgy1/reader"
import { ColumnView, IDTableView, StringPoolView } from "#rgy1/views"
import { type CountryRecord, CountryStatus } from "#types"

interface Tables {
	artifact: Artifact
	alpha2: IDTableView
	alpha3: IDTableView
	numeric: IDTableView
	columns: {
		alpha2Key: ColumnView
		alpha3Key: ColumnView
		numeric: ColumnView
		status: ColumnView
		name: ColumnView
		entityID: ColumnView
	}
	pool: StringPoolView
	records: Array<CountryRecord | undefined>
}

let tables: Tables | null = null

/**
 * The column order the compiler writes.
 * `header.columns` states the same order.
 */
const COLUMN = {
	alpha2Key: 0,
	alpha3Key: 1,
	numeric: 2,
	status: 3,
	name: 4,
	entityID: 5,
} as const

function openCountryTables(): Tables {
	if (tables) return tables

	const artifact = Artifact.parse(iso31661RecordsArtifact())

	tables = {
		artifact,
		alpha2: IDTableView.of(artifact, CODE_LENGTH_2),
		alpha3: IDTableView.of(artifact, CODE_LENGTH_3),
		numeric: IDTableView.of(artifact, ARITY_NUMERIC),
		columns: {
			alpha2Key: ColumnView.of(artifact, COLUMN.alpha2Key),
			alpha3Key: ColumnView.of(artifact, COLUMN.alpha3Key),
			numeric: ColumnView.of(artifact, COLUMN.numeric),
			status: ColumnView.of(artifact, COLUMN.status),
			name: ColumnView.of(artifact, COLUMN.name),
			entityID: ColumnView.of(artifact, COLUMN.entityID),
		},
		pool: StringPoolView.of(artifact),
		records: new Array<CountryRecord | undefined>(artifact.header.rows ?? 0),
	}

	return tables
}

const STATUSES: readonly CountryStatus[] = [CountryStatus.OfficiallyAssigned, CountryStatus.FormerlyUsed]

/**
 * The record at `row`, materialized once.
 */
export function countryRecordAt(row: number): CountryRecord | null {
	const tables_ = openCountryTables()

	if (row < 0 || row >= tables_.records.length) return null

	let record = tables_.records[row]

	if (!record) {
		const { columns, pool } = tables_

		record = Object.freeze({
			entityID: pool.get(columns.entityID.integer(row)) ?? "",
			alpha2: decode2(columns.alpha2Key.integer(row)),
			alpha3: decode3(columns.alpha3Key.integer(row)),
			numeric: decodeNumeric(columns.numeric.integer(row)),
			name: pool.get(columns.name.integer(row)) ?? "",
			status: STATUSES[columns.status.integer(row)] ?? CountryStatus.FormerlyUsed,
		})

		tables_.records[row] = record
	}

	return record
}

/**
 * The country holding an alpha-2 code in its canonical spelling, of any status, or `null`.
 */
export function getCountryByAlpha2(code: string): CountryRecord | null {
	return countryRecordAt(openCountryTables().alpha2.get(encode2(code)))
}

/**
 * The country holding an alpha-3 code in its canonical spelling, of any status, or `null`.
 */
export function getCountryByAlpha3(code: string): CountryRecord | null {
	return countryRecordAt(openCountryTables().alpha3.get(encode3(code)))
}

/**
 * The country holding a three-digit numeric code, of any status, or `null`.
 */
export function getCountryByNumeric(code: string): CountryRecord | null {
	return countryRecordAt(openCountryTables().numeric.get(encodeNumeric(code)))
}

/**
 * The number of country records of every status.
 */
export function countryRecordCount(): number {
	return openCountryTables().records.length
}

/**
 * The records artifact's header: profile, sources and coverage.
 */
export function countryRecordsHeader(): Artifact["header"] {
	return openCountryTables().artifact.header
}
