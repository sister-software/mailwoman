/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Typed schema for `bdc.db`, the FCC BDC availability read-side layer.
 *
 * In default mode (`includeLocationIDs` off), `bdc_availability` stores one row per distinct
 * `(geoid, provider_id, technology_code, speeds, low_latency, business_residential_code)` tuple
 * parsed from FCC provider CSVs, intentionally not collapsed to one row per
 * `(block, provider, technology)` when BSL-level speeds/flags differ. `bdc_provider` is a small
 * dictionary keyed by `provider_id`, populated later by the registry join.
 *
 * `bdc_availability` is a plain rowid table (mixed h3 range scans and geoid lookups fit better than
 * clustered composite-key storage); its `h3_cell` index is created with
 * {@link createBDCAvailabilityTable} and its `geoid` index after bulk load via
 * {@link createBDCGeoidIndex}.
 */

import type { layerschemadatabase } from "@mailwoman/core/layers"
import type { Kysely } from "kysely"

/**
 * One availability row from the FCC's per-provider BDC CSV, one row per distinct
 * (geoid, provider_id, technology_code, speeds, low_latency, business_residential_code) tuple in the
 * default build mode; a triple whose BSLs carry differing speed tiers keeps multiple rows here.
 */
export interface BDCAvailabilityTable {
	/**
	 * Res-9 integer short H3 cell of the block centroid (spine).
	 */
	h3_cell: number
	/**
	 * 15-char census block geoid (public spatial key).
	 */
	geoid: string
	/**
	 * Block-centroid PIP at build time (spine).
	 */
	wof_id: number | null
	provider_id: number
	technology_code: number
	max_advertised_download_speed: number
	max_advertised_upload_speed: number
	low_latency: 0 | 1
	business_residential_code: string
	/**
	 * Opaque BSL join key — never resolved (spec §2.2); null unless `--include-location-ids`.
	 */
	location_id: string | null
}

/**
 * Provider dictionary keyed on `provider_id`, populated only when `BuildBDCOptions.providers`
 * is supplied; the default leaves it empty.
 *
 * No FK against `bdc_availability.provider_id`, since SQLite does not enforce FKs
 * without `pragma foreign_keys` and the join happens at read time.
 *
 * An explicitly lossy denormalization rather than the source of truth: the FCC's
 * provider list lets one `provider_id` carry multiple `frn` values and conflicting
 * `holding_company` strings, which a one-row-per-provider table cannot express.
 * `filer.db` (`@mailwoman/filer`) retains every edge.
 *
 * - `frn` holds only the primary FRN — the one carrying the most recent Form
 *   499 filing date, per `@mailwoman/filer/sdk`'s `readFRNFilingCandidates` +
 *   `pickPrimaryFRN` (imported, never reimplemented).
 *   Every other FRN is recoverable from `filer.db`.
 * - `holding_company` is populated directly when its rows carry exactly one distinct non-null
 *   value, and stays NULL on a conflict because `holding_company` has no most-recent-filing
 *   rule the way `frn` does; every discarded value remains recoverable from `filer.db`.
 * - `brand_name` stays NULL unconditionally: the provider list carries no brand-name column.
 */
export interface BDCProviderTable {
	provider_id: number
	frn: string | null
	brand_name: string | null
	holding_company: string | null
}

export interface BDCDatabase extends layerschemadatabase {
	bdc_availability: BDCAvailabilityTable
	bdc_provider: BDCProviderTable
}

/**
 * H3 resolution for `bdc_availability.h3_cell` — the block-centroid spine resolution.
 */
export const BDC_H3_RESOLUTION = 9

/**
 * H3 resolution for `layer_coverage.h3_cell` in bdc.db, coarser than the availability spine
 * and matching poi.db's res-6 coverage-cell convention.
 */
export const BDC_COVERAGE_H3_RESOLUTION = 6

/**
 * Create `bdc_availability` with the `h3_cell` range-scan index every reader depends on.
 *
 * Call {@link createBDCGeoidIndex} separately, after bulk load, for the geoid point-lookup path.
 */
export async function createBDCAvailabilityTable(db: Kysely<BDCDatabase>): Promise<void> {
	await db.schema
		.createTable("bdc_availability")
		.addColumn("h3_cell", "integer", (c) => c.notNull())
		.addColumn("geoid", "text", (c) => c.notNull())
		.addColumn("wof_id", "integer")
		.addColumn("provider_id", "integer", (c) => c.notNull())
		.addColumn("technology_code", "integer", (c) => c.notNull())
		.addColumn("max_advertised_download_speed", "integer", (c) => c.notNull())
		.addColumn("max_advertised_upload_speed", "integer", (c) => c.notNull())
		.addColumn("low_latency", "integer", (c) => c.notNull())
		.addColumn("business_residential_code", "text", (c) => c.notNull())
		.addColumn("location_id", "text")
		.execute()

	await db.schema.createIndex("bdc_availability_h3_cell").on("bdc_availability").column("h3_cell").execute()
}

/**
 * Create `bdc_provider`.
 *
 * A single-column integer primary key is already the SQLite rowid alias,
 * and `without rowid` only pays off for a composite or non-integer key.
 */
export async function createBDCProviderTable(db: Kysely<BDCDatabase>): Promise<void> {
	await db.schema
		.createTable("bdc_provider")
		.addColumn("provider_id", "integer", (c) => c.primaryKey())
		.addColumn("frn", "text")
		.addColumn("brand_name", "text")
		.addColumn("holding_company", "text")
		.execute()
}

/**
 * Secondary index for the geoid point-lookup path, created after the bulk materialize
 * (index-after-load), matching poi.db's secondary indexes.
 */
export async function createBDCGeoidIndex(db: Kysely<BDCDatabase>): Promise<void> {
	await db.schema.createIndex("bdc_availability_geoid").on("bdc_availability").column("geoid").execute()
}
