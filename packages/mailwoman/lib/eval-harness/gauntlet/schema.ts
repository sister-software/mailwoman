/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Gauntlet — a full-pipeline integration-test corpus (`input → expected assembled output`). This is
 *   the CURATED REGRESSION layer (DeepSeek 019f1144): the executable memory of fixed bugs. Its check is
 *   REGRESSION-ONLY — "must not break what already passed" — and its pass-RATE is NEVER a ship gauge (that
 *   would re-invent the Pelias acceptance-test false-trust pass-list). Generalization is conditional elsewhere:
 *   the held-out fresh-draw runner (`holdout.ts`) and the metamorphic invariants (`metamorphic.ts`), which
 *   need no stored expected values and so can't be over-fit.
 *
 *   The `source` + `address_kind` columns are required: coverage is tracked BY KIND (po-box nonprofits,
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

/**
 * Pelias-style status: tracked as a DELTA (regression / improvement), never as a raw pass-rate gauge.
 */
export type CaseStatus = "pass" | "known_fail" | "improvement_target"

export type ResolutionTier = "address_point" | "interpolated" | "street" | "admin" | "venue" | "plus_code"

/**
 * One Gauntlet case: a raw input and its expected ASSEMBLED output (parse + place + coordinate + tier).
 */
export interface GauntletCaseTable {
	/**
	 * Stable case id, e.g. `fr-bare-chevaleret`.
	 */
	id: string
	/**
	 * The raw address string fed to the pipeline.
	 */
	input: string
	/**
	 * Provenance: where this case came from — `bug:#828`, `demo`, `nppes`, `golden`, `manual`.
	 */
	source: string
	/**
	 * The address KIND this case exercises (coverage is tracked by this).
	 */
	address_kind: AddressKind
	/**
	 * ISO-3166 alpha-2 country.
	 */
	country: string
	/**
	 * Expected status — the baseline the runner diffs against to report regressions vs improvements.
	 */
	status: CaseStatus
	/**
	 * Expected parse components as JSON `{ tag: value }` (null = parse not asserted for this case).
	 */
	expect_components: string | null
	/**
	 * OPT-IN multi-script rendering contract as JSON `{ tag: [rendering, …] }` (null = no contract). For a listed key the
	 * grader asserts that `scriptRenderings(got)` contains EVERY listed rendering, case-folded, and the same key in
	 * {@linkcode expect_components} is superseded — see `check-case.ts`. Every list must be non-empty (the seed schema
	 * refuses an empty one; the grader throws on one that reaches a built DB anyway).
	 */
	expect_component_renderings: string | null
	/**
	 * Expected resolved place id (null = place not asserted).
	 *
	 * Graded against `hierarchy[0].placeID` — see `check-case.ts`. Stored from the corpus's first migration and read by
	 * NOTHING until 2026-08-06 (#1507), which is worth knowing about any expectation column: it can sit in the schema,
	 * the builder and the DDL, look asserted, and assert nothing.
	 */
	expect_place_id: string | null
	/**
	 * Expected resolved place canonical name (null = not asserted), case-insensitive against `hierarchy[0].name`.
	 *
	 * NOT `GauntletResult.locality`, which echoes the parsed query span — see `check-case.ts`'s `resolvedPlace`.
	 */
	expect_place_name: string | null
	/**
	 * Expected coordinate (null = coordinate not asserted — e.g. a parse-only case).
	 */
	expect_lat: number | null
	expect_lon: number | null
	/**
	 * Accepted great-circle tolerance in METERS (Pelias's distanceThresh; null defaults at runtime).
	 */
	expect_tolerance_m: number | null
	/**
	 * Expected resolution tier — a result that drifts `address_point`→`admin` is a regression even within tolerance.
	 */
	expect_tier: ResolutionTier | null
	/**
	 * Optional resolver country prior (ISO-3166 alpha-2), forwarded as geocodeAddress's `defaultCountry`.
	 */
	default_country: string | null
	/**
	 * When the case entered the corpus (ISO date).
	 */
	added_at: string
	/**
	 * Linked bug / PR / issue, when the case is a fixed regression.
	 */
	bug_ref: string | null
	/**
	 * Human note — what failure this case pins.
	 */
	note: string | null
	/**
	 * ABLATION ONLY, and optional: a JSON `{ component: rung }` hand-pin overriding the ablation layer's DERIVED
	 * graceful-degradation ladder for this row (`{"country": "region"}`, `{"region": "abstain"}`). `rung` is `abstain`,
	 * `base`, or a WOF placetype naming the rung the deletion should degrade to.
	 *
	 * Absent (the normal case) = the derived ladder decides. It exists for the two classes no threshold fixes:
	 * TERRITORIES, whose ancestry is politically rather than geographically shaped, and DUAL-ROLE places (#402), where
	 * one name is both a locality and its own county and the ladder double-counts a rung. A corpus that needed many of
	 * these would be telling you the derivation is wrong, not that the rows are special.
	 */
	ablation_expect: string | null
	/**
	 * The CLI locale this row runs under (`en-NZ`), or null for the harness default. The runner derives the weights
	 * overlay from its region subtag, mirroring production's locale-gate routing. This is a LOCALE HINT, never a country
	 * constraint: `--locale` selects an address system and supplies a country prior, and an exact foreign match must
	 * still resolve under it (#1585's contract) — `country` above stays the TRUTH's country, which for a locale row can
	 * differ (`Paris` under `en-US` is an FR row run with the US overlay).
	 */
	locale: string | null
	/**
	 * 1 = this row's expected outcome is NO COORDINATE — the resolver abstains rather than answering. The grade inverts:
	 * any resolved coordinate fails the row. For the #1585 fuzzy-scope class, a scoped-empty typo correction must
	 * abstain, not fall through to a world-fuzzy candidate; the abstain pin IS the contract, and lands re-pinned to real
	 * coordinates once coverage arrives (the row's note says which artifact).
	 */
	expect_abstain: number | null
}

/**
 * The build stamp — ONE row, describing the committed corpus the DB was built from.
 *
 * Exists because `regression.db` is a derived artifact with no link back to its source: on 2026-08-06 `eval
 * gauntlet-build regression-db` rebuilt it from a STALE COMPILED TREE (an `out/` loader still holding the deleted
 * pre-JSONL case array), printed "built", and every check afterwards graded a corpus nobody had. Nothing in the DB
 * could contradict it. The stamp is that contradiction — the same posture as #1488's FST freshness stamps.
 */
export interface GauntletMetaTable {
	/**
	 * Always {@linkcode GAUNTLET_META_ROW_ID}. A one-row table pinned by its primary key, so a second write replaces the
	 * stamp rather than appending a second, equally-authoritative one.
	 */
	id: string
	/**
	 * `regressionCorpusHash` of the rows this DB was built from (`cases/load.ts`) — order-independent, content-addressed.
	 */
	corpus_hash: string
	/**
	 * How many rows were written. Redundant with the hash for detection, required for the DIAGNOSIS: "0 cases" reads as
	 * an empty loader, "306 vs 192" as a corpus that moved under the artifact.
	 */
	case_count: number
	/**
	 * ISO timestamp of the build, for the operator reading a mismatch ("built before or after my edit?").
	 */
	built_at: string
}

/**
 * The Gauntlet DB schema for `new DatabaseClient<GauntletDatabase>(...)`.
 */
export interface GauntletDatabase {
	gauntlet_case: GauntletCaseTable
	gauntlet_meta: GauntletMetaTable
}

/**
 * The one legal value of {@linkcode GauntletMetaTable.id}.
 */
export const GAUNTLET_META_ROW_ID = "corpus"

/**
 * Name of the stamp table, for the `sqlite_master` presence probe a pre-stamp DB needs.
 */
export const GAUNTLET_META_TABLE = "gauntlet_meta"

/**
 * Column order for the positional INSERT — derived once so the builder + writer can't drift.
 */
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
	"default_country",
	"added_at",
	"bug_ref",
	"note",
	// Appended 2026-08-05 (the ablation expectation model). APPEND-ONLY: this list is the positional INSERT order, so a
	// new column goes on the END or every existing row shifts.
	"ablation_expect",
	// Appended 2026-08-11 (the per-row multi-script rendering contract). Same append-only rule.
	"expect_component_renderings",
	// Appended 2026-08-11 (the #1585 fuzzy-scope board: per-row locale arm + the abstain contract).
	"locale",
	"expect_abstain",
] as const

/**
 * Create the `gauntlet_case` table (the curated regression corpus).
 */
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
		.addColumn("default_country", "text")
		.addColumn("added_at", "text", (c) => c.notNull())
		.addColumn("bug_ref", "text")
		.addColumn("note", "text")
		.addColumn("ablation_expect", "text")
		.addColumn("expect_component_renderings", "text")
		.addColumn("locale", "text")
		.addColumn("expect_abstain", "integer")
		.execute()

	// Coverage-by-kind is a first-class query: "how many kinds does the corpus cover, and which are thin?"
	await db.schema.createIndex("idx_gauntlet_kind").on("gauntlet_case").columns(["country", "address_kind"]).execute()
}

/**
 * Create the one-row {@linkcode GauntletMetaTable} build stamp.
 */
export async function createGauntletMetaTable(db: Kysely<GauntletDatabase>): Promise<void> {
	await db.schema
		.createTable(GAUNTLET_META_TABLE)
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("corpus_hash", "text", (c) => c.notNull())
		.addColumn("case_count", "integer", (c) => c.notNull())
		.addColumn("built_at", "text", (c) => c.notNull())
		.execute()
}
