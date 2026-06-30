/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Gauntlet — a full-pipeline integration-test corpus (`input → expected assembled output`). This is
 *   the CURATED REGRESSION layer (DeepSeek 019f1144): the executable memory of fixed bugs. Its gate is
 *   REGRESSION-ONLY — "must not break what already passed" — and its pass-RATE is NEVER a ship gauge (that
 *   would re-invent the Pelias acceptance-test false-trust pass-list). Generalization is gated elsewhere:
 *   the held-out fresh-draw runner (`holdout.ts`) and the metamorphic invariants (`metamorphic.ts`), which
 *   need no stored expected values and so can't be over-fit.
 *
 *   The `source` + `address_kind` columns are load-bearing: coverage is tracked BY KIND (po-box nonprofits,
 *   suite-heavy clinics, rural-route facilities, bare intl streets…), so "we tested 10k addresses" can never
 *   hide "…all suburban-US residential." That is CheckList's capability matrix applied to addresses.
 */

import type { Kysely } from "kysely"

/**
 * The address KIND a case exercises — a free string, deliberately extensible (the taxonomy grows with the corpus). Seed
 * examples: `fr_street_bare`, `fr_street_postcode`, `us_residential`, `us_business_suite`, `us_po_box`,
 * `us_rural_route`, `us_intersection`, `de_street`, `nl_street`, `intl_multitoken_street`.
 */
export type AddressKind = string

/** Pelias-style status: tracked as a DELTA (regression / improvement), never as a raw pass-rate gauge. */
export type CaseStatus = "pass" | "known_fail" | "improvement_target"

export type ResolutionTier = "address_point" | "interpolated" | "admin"

/** One Gauntlet case: a raw input and its expected ASSEMBLED output (parse + place + coordinate + tier). */
export interface GauntletCaseTable {
	/** Stable case id, e.g. `fr-bare-chevaleret`. */
	id: string
	/** The raw address string fed to the pipeline. */
	input: string
	/** Provenance: where this case came from — `bug:#828`, `demo`, `nppes`, `golden`, `manual`. */
	source: string
	/** The address KIND this case exercises (coverage is tracked by this). */
	address_kind: AddressKind
	/** ISO-3166 alpha-2 country. */
	country: string
	/** Expected status — the baseline the runner diffs against to report regressions vs improvements. */
	status: CaseStatus
	/** Expected parse components as JSON `{ tag: value }` (null = parse not asserted for this case). */
	expect_components: string | null
	/** Expected resolved place id (null = place not asserted). */
	expect_place_id: string | null
	/** Expected resolved place canonical name (null = not asserted). */
	expect_place_name: string | null
	/** Expected coordinate (null = coordinate not asserted — e.g. a parse-only case). */
	expect_lat: number | null
	expect_lon: number | null
	/** Accepted great-circle tolerance in METERS (Pelias's distanceThresh; null defaults at runtime). */
	expect_tolerance_m: number | null
	/** Expected resolution tier — a result that drifts `address_point`→`admin` is a regression even within tolerance. */
	expect_tier: ResolutionTier | null
	/** When the case entered the corpus (ISO date). */
	added_at: string
	/** Linked bug / PR / issue, when the case is a fixed regression. */
	bug_ref: string | null
	/** Human note — what failure this case pins. */
	note: string | null
}

/** The Gauntlet DB schema for `new DatabaseClient<GauntletDatabase>(...)`. */
export interface GauntletDatabase {
	gauntlet_case: GauntletCaseTable
}

/** Column order for the positional INSERT — derived once so the builder + writer can't drift. */
export const GAUNTLET_CASE_COLUMNS = [
	"id",
	"input",
	"source",
	"address_kind",
	"country",
	"status",
	"expect_components",
	"expect_place_id",
	"expect_place_name",
	"expect_lat",
	"expect_lon",
	"expect_tolerance_m",
	"expect_tier",
	"added_at",
	"bug_ref",
	"note",
] as const

/** Create the `gauntlet_case` table (the curated regression corpus). */
export async function createGauntletTable(db: Kysely<GauntletDatabase>): Promise<void> {
	await db.schema
		.createTable("gauntlet_case")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("input", "text", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("address_kind", "text", (c) => c.notNull())
		.addColumn("country", "text", (c) => c.notNull())
		.addColumn("status", "text", (c) => c.notNull())
		.addColumn("expect_components", "text")
		.addColumn("expect_place_id", "text")
		.addColumn("expect_place_name", "text")
		.addColumn("expect_lat", "real")
		.addColumn("expect_lon", "real")
		.addColumn("expect_tolerance_m", "integer")
		.addColumn("expect_tier", "text")
		.addColumn("added_at", "text", (c) => c.notNull())
		.addColumn("bug_ref", "text")
		.addColumn("note", "text")
		.execute()
	// Coverage-by-kind is a first-class query: "how many kinds does the corpus cover, and which are thin?"
	await db.schema.createIndex("idx_gauntlet_kind").on("gauntlet_case").columns(["country", "address_kind"]).execute()
}
