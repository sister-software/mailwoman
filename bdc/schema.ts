/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for bdc.db — the FCC Broadband Data Collection availability read-side layer (2a
 *   decisions 4, 8). `bdc_availability` holds, in the default (non-`includeLocationIDs`) build mode, one
 *   row per DISTINCT (geoid, provider_id, technology_code, max_advertised_download_speed,
 *   max_advertised_upload_speed, low_latency, business_residential_code) tuple parsed from the FCC's
 *   per-provider CSV (see `sdk/parsing.ts`) — NOT one row per (block, provider, technology) triple: when
 *   two Broadband Serviceable Locations in the same block file different speeds/flags for the same
 *   provider/technology, both rows survive `build-bdc.ts`'s materialize-time collapse (see that file's
 *   docstring; accepted FCC filing behavior, not a bug). `bdc_provider` is a small dictionary
 *   keyed on `provider_id`, populated by a later registry-join task — decision 8 keeps FRN/brand/
 *   holding-company resolution out of 2a's scope. The DB also embeds the layer-contract tables from
 *   `@mailwoman/core/layers` (manifest tier `shipped`, license `public-domain` — FCC BDC block-level
 *   availability data, at the granularity this layer ships, is US government public-domain data, not
 *   redistribution-restricted; the CostQuest Fabric boundary this workspace never crosses is the
 *   licensing edge, see `bdc/README.md` — spine `h3` res 9 for availability rows, res 6 for coverage
 *   cells, matching poi.db's convention).
 *
 *   Clustering decision (implementer's pick — the brief allows either): a PLAIN rowid table, NOT
 *   `WITHOUT ROWID`, and NOT a composite `(h3_cell, provider_id, technology_code)` primary key.
 *   `WITHOUT ROWID` earns its keep on small, PK-probed rows — poi.db's clustered key and
 *   `layer_coverage`'s per-cell probe both read by their exact PK and nothing else, so folding the row
 *   into the B-tree removes a second lookup. `bdc_availability` doesn't fit that shape: it's a wider,
 *   10-column row read two different ways — an h3-range scan ("everything near this cell", the
 *   coverage/overlay path) and a geoid point lookup (the public spatial join key TIGER and callers
 *   actually probe by) — never a single composite-key point probe. Clustering the full row under a
 *   composite PK would also force the bulk loader to sort-then-insert in that exact key order across
 *   millions of rows spread over per-provider, per-state source files, for a locality win a plain
 *   index already delivers without constraining ingest order. So: a regular rowid table, an index on
 *   `h3_cell` bundled into {@link createBDCAvailabilityTable} (every reader depends on it, same as the
 *   table itself), and {@link createBDCGeoidIndex} as a separate, callable-after-bulk-load secondary
 *   index for the geoid path — the index-after-load discipline used elsewhere in this repo (see
 *   poi-schema.ts's name_key/brand indexes).
 */

import type { LayerContractDatabase } from "@mailwoman/core/layers"
import type { Kysely } from "kysely"

/**
 * One availability row from the FCC's per-provider BDC CSV. In the default build mode this is one row per DISTINCT
 * (geoid, provider_id, technology_code, speeds, low_latency, business_residential_code) tuple — NOT one row per (block,
 * provider, technology) triple; a triple whose BSLs carry differing speed tiers keeps multiple rows here (see
 * `build-bdc.ts`'s docstring).
 */
export interface BDCAvailabilityTable {
	/**
	 * Res-9 integer short H3 cell of the block centroid (spine).
	 */
	h3_cell: number
	/**
	 * 15-char census block GEOID (public spatial key).
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
	 * Opaque BSL join key — NEVER resolved (spec §2.2); null unless `--include-location-ids`.
	 */
	location_id: string | null
}

/**
 * Provider dictionary keyed on `provider_id`. Populated by a later registry-join task (2a decision 8) — that task is 3a
 * Task 8's optional `BuildBDCOptions.providers` (`bdc/sdk/build-bdc.ts`'s `populateBDCProviderTable`); when that option
 * is omitted (the default), this table stays empty, exactly as it did before Task 8. No FK constraint against
 * `bdc_availability.provider_id` — SQLite doesn't enforce FKs without `PRAGMA foreign_keys`, and the join happens at
 * read time, not write time.
 *
 * **Decision 6 — this table is an explicitly LOSSY denormalization, not the source of truth.** `provider_id` is the PK
 * (one row per provider), but the FCC's BDC provider list lets one `provider_id` carry MULTIPLE `frn` values — and
 * conflicting `holding_company` strings — across its rows (Task 3's `parseProviderList` preserves every one of them;
 * see `filer/sdk/provider-list.ts`). A single-row-per-provider table cannot express that cardinality. `filer.db`
 * (`@mailwoman/filer`) is the source of truth: it retains every `provider_id`↔`frn` (and
 * `provider_id`↔`holding_company_name`) edge, never folded or last-wins. When `bdc.db` is built with
 * `BuildBDCOptions.providers` supplied:
 *
 * - `frn` holds only the PRIMARY FRN — the one carrying the most recent Form 499 filing date, per
 *   `@mailwoman/filer/sdk`'s `readFRNFilingCandidates` + `pickPrimaryFRN` (imported into `build-bdc.ts`, never
 *   reimplemented — Task 7's review found and fixed a temporal bug in that exact query, one a fresh implementation
 *   would reintroduce). Every OTHER FRN that `provider_id` carries is discarded here but stays fully recoverable from
 *   `filer.db`.
 * - `holding_company` gets the SAME single-distinct-value shortcut `frn` gets (review fix round 1, IMPORTANT-3): when a
 *   `provider_id`'s rows carry exactly one distinct non-null `holding_company` string, there is no conflict to resolve,
 *   so it's populated directly — no rule needed, same as a single-FRN provider needs no `filerDB` query. When they
 *   carry MORE than one distinct value, that ambiguity is the real conflict decision 6 refuses to paper over with
 *   last-wins (`holding_company` has no most-recent-filing-date rule the way `frn` does), so it stays NULL and every
 *   discarded value remains recoverable from `filer.db`'s `holding_company_name` edges — the identical discipline
 *   `frn`'s primary pick already applies.
 * - `brand_name` stays NULL unconditionally: the provider list carries no brand-name column at all, primary or otherwise,
 *   so there is nothing to populate it from.
 */
export interface BDCProviderTable {
	/**
	 * PK.
	 */
	provider_id: number
	frn: string | null
	brand_name: string | null
	holding_company: string | null
}

export interface BDCDatabase extends LayerContractDatabase {
	bdc_availability: BDCAvailabilityTable
	bdc_provider: BDCProviderTable
}

/**
 * H3 resolution for `bdc_availability.h3_cell` — the block-centroid spine resolution.
 */
export const BDC_H3_RESOLUTION = 9

/**
 * H3 resolution for `layer_coverage.h3_cell` in bdc.db — coarser than the availability spine, matching poi.db's res-6
 * coverage-cell convention.
 */
export const BDC_COVERAGE_H3_RESOLUTION = 6

/**
 * Create `bdc_availability` as a plain rowid table, plus the `h3_cell` range-scan index (bundled here since every
 * reader depends on it — see the file header for the clustering rationale). Call {@link createBDCGeoidIndex}
 * separately, after bulk load, for the geoid point-lookup path.
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
 * Create `bdc_provider`. A single-column INTEGER PRIMARY KEY is already the SQLite rowid alias, so there's no `WITHOUT
 * ROWID` win here — that modifier only pays off clustering a composite or non-integer PK.
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
 * Secondary index for the geoid point-lookup path (the public spatial join key). Call AFTER the bulk materialize
 * (index-after-load), same discipline as poi.db's secondary indexes.
 */
export async function createBDCGeoidIndex(db: Kysely<BDCDatabase>): Promise<void> {
	await db.schema.createIndex("bdc_availability_geoid").on("bdc_availability").column("geoid").execute()
}
