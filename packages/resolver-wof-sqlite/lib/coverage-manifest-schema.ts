/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Schema and read/write helpers for the candidate gazetteer's coverage manifest.
 *
 *   The manifest holds two country-keyed tables. `country_coverage` records each measured country's hard-filter
 *   verdict. A missing row means the country was never measured, and `hard_filter_safe = 0` means it was measured and
 *   failed. `country_bbox` holds coarse plausibility boxes, and a missing row never trips the guard.
 */

import {
	hardCountrySafelistFromCoverage,
	type CountryBBoxFact,
	type CountryCoverageFact,
	type GazetteerArtifactCoverage,
} from "@mailwoman/core/resolver"
import { allRows } from "@mailwoman/core/utils"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql, type Kysely } from "kysely"

import { hasTable } from "#sqlite-utils"

/**
 * The stored form of {@link CountryCoverageFact}, one row per country.
 */
export interface CountryCoverageTable {
	/**
	 * The upper-case ISO 3166-1 alpha-2 code, which is the primary key.
	 */
	country: string
	/**
	 * The promotion-eval verdict as 0 or 1.
	 *
	 * It is stored directly because the rate alone does not decide it.
	 */
	hard_filter_safe: number
	/**
	 * The hard-resolve rate from 0 to 1 on the panel given in `source`, or NULL when none was recorded.
	 */
	hard_resolve_rate: number | null
	/**
	 * The panel size behind `hard_resolve_rate`, or NULL when none was recorded.
	 */
	sample_size: number | null
	/**
	 * The ISO 8601 date of the measurement.
	 */
	measured_at: string
	/**
	 * The panel or check that produced this row.
	 */
	source: string
}

/**
 * The stored form of {@link CountryBBoxFact}, one coarse bounding box per country.
 */
export interface CountryBBoxTable {
	/**
	 * The upper-case ISO 3166-1 alpha-2 code, which is the primary key.
	 */
	country: string
	lat_min: number
	lat_max: number
	lon_min: number
	lon_max: number
	/**
	 * The provenance of the box.
	 */
	source: string
}

/**
 * The coverage-manifest schema for `new DatabaseClient<GazetteerCoverageDatabase>(...)`.
 */
export interface GazetteerCoverageDatabase {
	country_coverage: CountryCoverageTable
	country_bbox: CountryBBoxTable
}

/**
 * The name of the per-country coverage table.
 * Readers check that it exists before querying it.
 */
export const COUNTRY_COVERAGE_TABLE = "country_coverage"
/**
 * The name of the per-country bounding-box table, used to reject a placement outside its own country.
 */
export const COUNTRY_BBOX_TABLE = "country_bbox"

/**
 * Creates the `country_coverage` table as a `WITHOUT ROWID` table keyed by country.
 */
export async function createCountryCoverageTable(db: Kysely<GazetteerCoverageDatabase>): Promise<void> {
	await db.schema
		.createTable(COUNTRY_COVERAGE_TABLE)
		.ifNotExists()
		.addColumn("country", "text", (c) => c.primaryKey())
		.addColumn("hard_filter_safe", "integer", (c) => c.notNull())
		.addColumn("hard_resolve_rate", "real")
		.addColumn("sample_size", "integer")
		.addColumn("measured_at", "text", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		// Kysely has no builder method for `without rowid`.
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Creates the `country_bbox` table as a `WITHOUT ROWID` table keyed by country.
 */
export async function createCountryBBoxTable(db: Kysely<GazetteerCoverageDatabase>): Promise<void> {
	await db.schema
		.createTable(COUNTRY_BBOX_TABLE)
		.ifNotExists()
		.addColumn("country", "text", (c) => c.primaryKey())
		.addColumn("lat_min", "real", (c) => c.notNull())
		.addColumn("lat_max", "real", (c) => c.notNull())
		.addColumn("lon_min", "real", (c) => c.notNull())
		.addColumn("lon_max", "real", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Creates both manifest tables in a candidate database under construction and inserts the facts.
 *
 * The gazetteer build calls it once.
 * A shipped database is rebuilt instead of patched.
 */
export async function writeGazetteerCoverageManifest(
	db: Kysely<GazetteerCoverageDatabase>,
	facts: { coverage: readonly CountryCoverageFact[]; bboxes: readonly CountryBBoxFact[] }
): Promise<void> {
	await createCountryCoverageTable(db)
	await createCountryBBoxTable(db)

	if (facts.coverage.length) {
		await db
			.insertInto(COUNTRY_COVERAGE_TABLE)
			.values(
				facts.coverage.map((f) => ({
					country: f.country.toUpperCase(),
					hard_filter_safe: f.hardFilterSafe ? 1 : 0,
					hard_resolve_rate: f.hardResolveRate ?? null,
					sample_size: f.sampleSize ?? null,
					measured_at: f.measuredAt,
					source: f.source,
				}))
			)
			.execute()
	}

	if (facts.bboxes.length) {
		await db
			.insertInto(COUNTRY_BBOX_TABLE)
			.values(
				facts.bboxes.map((f) => ({
					country: f.country.toUpperCase(),
					lat_min: f.latMin,
					lat_max: f.latMax,
					lon_min: f.lonMin,
					lon_max: f.lonMax,
					source: f.source,
				}))
			)
			.execute()
	}
}

/**
 * Reads the coverage manifest from an open candidate database.
 *
 * It returns `undefined` when neither table exists, and consumers then fall back to the code constants.
 * The reads are synchronous because the candidate lookup calls this from its constructor.
 */
export function readGazetteerCoverageManifest<DB>(db: DatabaseClient<DB>): GazetteerArtifactCoverage | undefined {
	const hasCoverage = hasTable(db, COUNTRY_COVERAGE_TABLE)
	const hasBBox = hasTable(db, COUNTRY_BBOX_TABLE)

	if (!hasCoverage && !hasBBox) return undefined

	const countryCoverage = new Map<string, CountryCoverageFact>()

	if (hasCoverage) {
		const rows = allRows<CountryCoverageTable>(
			db.prepare(
				`SELECT country, hard_filter_safe, hard_resolve_rate, sample_size, measured_at, source FROM ${COUNTRY_COVERAGE_TABLE}`
			)
		)

		for (const row of rows) {
			const country = String(row.country).toUpperCase()

			countryCoverage.set(country, {
				country,
				hardFilterSafe: Number(row.hard_filter_safe) !== 0,
				...(row.hard_resolve_rate === null ? {} : { hardResolveRate: Number(row.hard_resolve_rate) }),
				...(row.sample_size === null ? {} : { sampleSize: Number(row.sample_size) }),
				measuredAt: String(row.measured_at),
				source: String(row.source),
			})
		}
	}

	const countryBBoxes = new Map<string, CountryBBoxFact>()

	if (hasBBox) {
		const rows = allRows<CountryBBoxTable>(
			db.prepare(`SELECT country, lat_min, lat_max, lon_min, lon_max, source FROM ${COUNTRY_BBOX_TABLE}`)
		)

		for (const row of rows) {
			const country = String(row.country).toUpperCase()

			countryBBoxes.set(country, {
				country,
				latMin: Number(row.lat_min),
				latMax: Number(row.lat_max),
				lonMin: Number(row.lon_min),
				lonMax: Number(row.lon_max),
				source: String(row.source),
			})
		}
	}

	return {
		countryCoverage,
		countryBBoxes,
		hardCountrySafelist: hardCountrySafelistFromCoverage(countryCoverage.values()),
	}
}
