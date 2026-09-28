/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Gauntlet — a full-pipeline integration-test corpus (`input → expected assembled output`). This is the
 *   curated regression layer: the executable memory of fixed bugs. Its check is regression-only — "must not
 *   break what already passed" — and its pass-rate is never a ship gauge. Generalization is conditional
 *   elsewhere, in the held-out fresh-draw runner (`holdout.ts`) and the metamorphic invariants
 *   (`metamorphic.ts`), which need no stored expected values and so cannot be over-fit.
 *
 *   The `source` + `address_kind` columns are required: coverage is tracked BY kind, so a total can never hide
 *   that every row is the same kind.
 */

import type { ResolutionTier } from "@mailwoman/annotations/geo"
import type { Kysely } from "kysely"

/**
 * The address kind a case exercises — a free string, deliberately extensible because the taxonomy
 * grows with the corpus (seed examples: `fr_street_bare`, `us_residential`, `us_po_box`, `de_street`).
 */
export type AddressKind = string

/**
 * Pelias-style status: tracked as a delta (regression / improvement), never as a raw pass-rate gauge.
 */
export type CaseStatus = "pass" | "known_fail" | "improvement_target"

/**
 * One Gauntlet case: a raw input and its expected assembled output (parse + place + coordinate + tier).
 */
export interface GauntletCaseTable {
	/**
	 * Stable case id, e.g. `fr-bare-chevaleret`.
	 */
	id: string
	input: string
	/**
	 * Provenance: where this case came from — `bug:#828`, `demo`, `nppes`, `golden`, `manual`.
	 */
	source: string
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
	 * OPT-IN multi-script rendering interface as JSON `{ tag: [rendering, …] }` (null = no interface);
	 * for a listed key the grader asserts that `scriptRenderings(got)` contains every listed
	 * rendering, case-folded, and supersedes the same key in {@linkcode expect_components},
	 * while every list must be non-empty (both the seed schema and the grader refuse an empty one).
	 */
	expect_component_renderings: string | null
	/**
	 * Expected resolved place id (null = place not asserted), graded against
	 * `hierarchy[0].placeID` — an expectation column can sit in the schema and DDL,
	 * look asserted, and assert no fact, so this is read by `check-case.ts`.
	 */
	expect_place_id: string | null
	/**
	 * Expected resolved place canonical name (null = not asserted), case-insensitive against
	 * `hierarchy[0].name` rather than `GauntletResult.locality`, which echoes the parsed query span.
	 */
	expect_place_name: string | null
	/**
	 * Expected coordinate (null = coordinate not asserted, such as a parse-only case).
	 */
	expect_lat: number | null
	expect_lon: number | null
	/**
	 * Accepted great-circle tolerance in meters (Pelias's distanceThresh); null defaults at runtime.
	 */
	expect_tolerance_m: number | null
	/**
	 * Expected resolution tier.
	 *
	 * A result that drifts `address_point`→`admin` is a regression even within tolerance.
	 */
	expect_tier: ResolutionTier | null
	/**
	 * Optional resolver country prior (ISO-3166 alpha-2), forwarded as `geocodeAddress`'s `defaultCountry`.
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
	 * Ablation only, and optional: a JSON `{ component: rung }` hand-pin overriding the ablation layer's
	 * derived graceful-degradation ladder for this row (`{"country": "region"}`, `{"region": "abstain"}`),
	 * where `rung` is `abstain`, `base`, or a WOF placetype.
	 *
	 * Absent means the derived ladder decides.
	 * The pin exists for the two classes no threshold fixes — territories, whose ancestry
	 * is politically rather than geographically shaped, and dual-role places, where one
	 * name is both a locality and its own county and the ladder double-counts a rung.
	 */
	ablation_expect: string | null
	/**
	 * The CLI locale this row runs under (`en-NZ`), or null for the harness default.
	 *
	 * The runner derives the weights overlay from its region subtag,
	 * mirroring production's locale-hint routing.
	 *
	 * It is a locale hint, never a country constraint — `country` above stays the truth's
	 * country, so `Paris` under `en-US` is an FR row run with the US overlay.
	 */
	locale: string | null
	/**
	 * 1 = this row's expected outcome is no coordinate, so the resolver abstains rather than answering and any resolved coordinate fails the row.
	 *
	 * For the fuzzy-scope class, a scoped-empty typo correction must abstain
	 * rather than fall through to a world-fuzzy candidate.
	 *
	 * The abstain pin is the interface, and lands re-pinned to real coordinates once
	 * coverage arrives (the row's note says which artifact).
	 */
	expect_abstain: number | null
}

/**
 * The build stamp — one row, describing the committed corpus the DB was built from. it exists
 * because `regression.db` is a derived artifact with no link back to its source,
 * and no record in the DB could contradict a wrong build.
 */
export interface GauntletMetaTable {
	/**
	 * Always {@linkcode GAUNTLET_META_ROW_ID}; a one-row table pinned by its primary key, so a
	 * second write replaces the stamp rather than appending a second, equally-authoritative one.
	 */
	id: string
	/**
	 * `regressionCorpusHash` of the rows this DB was built from (`cases/load.ts`) —
	 * order-independent and content-addressed.
	 */
	corpus_hash: string
	/**
	 * How many rows were written.
	 *
	 * Redundant with the hash for detection but required for the diagnosis, since "0 cases"
	 * reads as an empty loader and "306 vs 192" as a corpus that moved under the artifact.
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
 * Column order for the positional insert — derived once so the builder + writer can't drift.
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
	// Append-only: this list is the positional insert order, so a new column goes
	// on the END or every existing row shifts.
	"ablation_expect",
	"expect_component_renderings",
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
