/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Typed schema for filer.db — the identity crosswalk read-side layer. Deliberately not a layer-interface artifact:
 * filer.db has no coordinate references until ASR arrives, and `@mailwoman/core/layers`' `layer_coverage` is H3-keyed,
 * so `filer_manifest` is filer.db's own single-row identity/provenance record — see {@link readFilerManifest}, which
 * copies `readLayerManifest`'s throw-unless-exactly-one discipline without reusing its table or its
 * tier/freshness-policy/spine-key validation.
 *
 * `filer_node` is the crosswalk's join surface, one row per identifier instance (an FRN, a Form 499 ID, a spin, a BDC
 * `provider_id`, a holding- or management-company name), keyed on the synthetic
 * `node_id = "${identifier_type}:${identifier_value}"`; `filer_edge` asserts a relationship between two nodes as
 * reported by one source at one vintage.
 *
 * `valid_from` is mandatory on every edge and the primary key is the 4-tuple `(from_node_id, to_node_id, source,
 * valid_from)`, so two sources asserting the same relationship — or one source revising its assertion at a later
 * vintage — produce two rows rather than a silent overwrite, which is the point of carrying provenance.
 * `FilerEdgeTable` has no `Generated<>`-wrapped columns, so `Insertable<FilerEdgeTable>` requires every field
 * including the nullable ones as an explicit `null`.
 *
 * The composite PK is a plain `unique` index rather than `without rowid` because `evidence` is an unbounded JSON
 * blob and the dominant read pattern is a range scan, not a composite-key point probe; `filer_node`'s single-column
 * text PK stays a rowid table for the same lack of a second column to fold in.
 *
 * Strength and kind are orthogonal columns: {@link FilerEdgeAssertion} grades how strongly an assertion is evidenced
 * and {@link FilerRelationship} says what it means. `relationship` is not part of either primary key, because one
 * source asserting two relationship kinds for the same pair at the same instant is a contradiction to reject rather
 * than a plurality to store.
 *
 * `filer_cluster` and `filer_family` are distinct rollups the spec keeps apart — an entity cluster (same filer under
 * different identifiers) and a corporate family (a holding/parent/subsidiary/management tree spanning several
 * filers) — see {@link FilerFamilyTable}.
 *
 * `naming_node_id` carries a family fact's naming provenance: `family_id` is a canonicalized slug, and re-running the
 * canonicalizer at read time would put a sealed, separately-versioned artifact's output at the mercy of a
 * designation-list edit in another workspace, with no manifest field pinning the canonicalizer's identity, so every
 * display name could silently disappear. See {@link FilerFamilyTable}.
 *
 * `filer_family` carries `assertion` + `match_score` too, because criterion 2 (`inferred never merges with
 * authoritative`) enforced on `filer_edge` alone stops at the table boundary while edgar writes inferred family
 * memberships, and `source` cannot stand in because `edgar-exhibit-21` writes both grades under one source name.
 */

import { sql, type Kysely } from "kysely"

/**
 * The identifier namespaces a `filer_node.node_id` can be minted from (no enum, per the repo rule).
 *
 * `spin` is defined but unpopulated: neither `filer/sdk` parser carries a spin field
 * and `build-filer.ts` mints no `spin:` node, so the namespace is reserved for
 * a future source that actually carries one.
 *
 * `CIK` is SEC edgar's Central Index Key, always the zero-padded 10-digit string form
 * (matching how `data.sec.gov/submissions/CIK##########.json` names itself) and never the
 * bare unpadded number, mirroring `FRN`'s zero-padding convention because a bare `"320193"`
 * would collide with a differently-padded value under naive string comparison.
 *
 * `SubsidiaryName` is a raw subsidiary name exactly as one parent CIK's Exhibit 21 disclosed it,
 * sharing the `HoldingCompanyName`/`ManagementCompanyName` global name-node shape but kept in its own
 * namespace because those name the source filer's own parent/manager rather than a company it owns.
 */
export const FilerIdentifierType = {
	FRN: "frn",
	Form499ID: "form499_id",
	SPIN: "spin",
	BDCProviderID: "bdc_provider_id",
	HoldingCompanyName: "holding_company_name",
	ManagementCompanyName: "management_company_name",
	CIK: "cik",
	SubsidiaryName: "subsidiary_name",
} as const

export type FilerIdentifierType = (typeof FilerIdentifierType)[keyof typeof FilerIdentifierType]

/**
 * How a `filer_edge` relationship was established: `Authoritative` when the source
 * document states it directly, `Inferred` when derived by name/address comparators,
 * which carries `match_score` and `evidence`.
 */
export const FilerEdgeAssertion = {
	Authoritative: "authoritative",
	Inferred: "inferred",
} as const

export type FilerEdgeAssertion = (typeof FilerEdgeAssertion)[keyof typeof FilerEdgeAssertion]

/**
 * The kind of relationship a `filer_edge` or `filer_family` row asserts between two nodes,
 * orthogonal to {@link FilerEdgeAssertion}, which grades how strongly the same
 * assertion is evidenced rather than what it means.
 *
 * - `SameEntity` — the two nodes denote the same underlying filer under different
 *   identifiers; the only kind `cluster-filers.ts` asserts.
 * - `HoldingCompany` — the target node is the source node's holding company (an ownership fact).
 * - `ManagementCompany` — the target operates/manages the source without owning it;
 *   ownership and operational control are different assertions (spec §3.1 finding 1).
 * - `ParentCompany` — the target is the source's parent in a corporate-family rollup
 *   ({@link FilerFamilyTable}), a family-tree fact rather than necessarily an ownership filing.
 * - `Subsidiary` — the inverse of `ParentCompany`, kept as its own value so a row's
 *   `relationship` always describes the edge in the direction it was asserted.
 * - `SupersededBy` — the source registration was replaced by the target one, an
 *   identity-continuity fact rather than ownership or control; the edge is directional in time
 *   (the source is always the older registration) and `linkage-eval.ts`'s `OWNERSHIP_BY_RELATIONSHIP`
 *   pins it `false`, because a supersession chain is not evidence of a corporate family.
 */
export const FilerRelationship = {
	SameEntity: "same_entity",
	HoldingCompany: "holding_company",
	ManagementCompany: "management_company",
	ParentCompany: "parent_company",
	Subsidiary: "subsidiary",
	SupersededBy: "superseded_by",
} as const

export type FilerRelationship = (typeof FilerRelationship)[keyof typeof FilerRelationship]

/**
 * One identifier instance in the crosswalk.
 */
export interface FilerNodeTable {
	/**
	 * PK, the `` `${identifier_type}:${identifier_value}` `` synthetic key.
	 */
	node_id: string
	identifier_type: string
	identifier_value: string
}

/**
 * One source's assertion, at one vintage, that two nodes denote the same filer.
 */
export interface FilerEdgeTable {
	from_node_id: string
	to_node_id: string
	assertion: string
	relationship: string
	source: string
	source_vintage: string
	/**
	 * Mandatory; every edge asserts a start of validity, so use the filing's vintage/date
	 * when no finer-grained date exists.
	 */
	valid_from: string
	/**
	 * Null while the assertion is still in force; when set, the window is half-open
	 * (`valid_from <= t < valid_to`), with `valid_to` the first date the assertion
	 * no longer holds rather than the last date it did.
	 *
	 * This is forced rather than stylistic: `cluster-filers.ts`'s `clusterInferredLinks`
	 * closes a superseded edge and inserts its replacement at the same `validFrom`,
	 * so an inclusive-inclusive convention would make both rows claim to be in force on
	 * that date; every `asOf`-scoped reader must apply the matching predicate.
	 */
	valid_to: string | null
	/**
	 * Inferred only; null for authoritative assertions.
	 */
	match_score: number | null
	/**
	 * JSON-encoded match evidence; inferred only and null for authoritative assertions.
	 */
	evidence: string | null
}

/**
 * A key/value fact about a node (a brand name, an address captured as free text);
 * provenance-plural like `filer_edge`, so the same `(node_id, key)` from two
 * sources produces two rows rather than a clobber.
 */
export interface FilerAttributeTable {
	node_id: string
	key: string
	value: string
	source: string
	source_vintage: string
}

/**
 * Cluster membership: which entity cluster a node was assigned to and
 * whether the assignment is authoritative or inferred.
 */
export interface FilerClusterTable {
	node_id: string
	cluster_id: string
	assertion: string
}

/**
 * Corporate-family membership, the distinction `filer_cluster` never had: one row asserts
 * that `node_id` belongs to `family_id` (named by `naming_node_id`'s raw spelling)
 * under a {@link FilerRelationship} at a {@link FilerEdgeAssertion} strength,
 * reported by one source at one vintage and provenance-plural like `filer_edge`.
 */
export interface FilerFamilyTable {
	node_id: string
	family_id: string
	/**
	 * The `filer_node.node_id` of the holding-/management-company node whose raw
	 * `identifier_value` was canonicalized to produce this row's `family_id`,
	 * persisted at build time so no reader re-derives it.
	 */
	naming_node_id: string
	/**
	 * How strongly this membership is evidenced; `authoritative` is stated directly by
	 * the source document (a Form 499 row naming its own holding company) and `inferred`
	 * is one a matcher concluded (edgar's subsidiary-name→FRN corroboration).
	 */
	assertion: string
	relationship: string
	source: string
	source_vintage: string
	valid_from: string
	valid_to: string | null
	/**
	 * Inferred only and null for authoritative memberships, which `filer_family_match_score_inferred_only`
	 * enforces in one direction; an inferred row carrying no score gives a caller no
	 * signal about how far to trust it, but matching `filer_edge`'s permissiveness that
	 * direction is a writer's obligation rather than a constraint.
	 */
	match_score: number | null
}

/**
 * The `filer_manifest.schema_version` at which `filer_edge` gained its not-NULL
 * `relationship` column and `filer_family` was introduced.
 *
 * Readers that hard-depend on either (`filer-lookup.ts`'s `families` field,
 * `family-rollup.ts`'s `familyRollup`) must refuse an earlier artifact with a descriptive,
 * rebuild-pointing error rather than a raw `no such table: filer_family` straight from SQLite.
 */
export const FILER_FAMILY_SCHEMA_VERSION = 2

/**
 * The current `schema_version` — version 3, which added {@link FilerRelationship.SupersededBy}
 * and made `filer_edge.valid_to` a column something actually writes.
 *
 * No table changed shape between 2 and 3, so a version-2 artifact is structurally readable,
 * but it cannot be trusted about content: every ceased filer in a version-2 build
 * carries `valid_to: null`, so an `asOf`-scoped read answers a carrier dissolved a
 * decade earlier with no error — a worse failure than a missing table.
 *
 * Readers should therefore compare against {@linkcode FILER_FAMILY_SCHEMA_VERSION} for
 * can-I-read-this and against this constant for should-I-trust-a-temporal-answer.
 */
export const FILER_SCHEMA_VERSION = 3

/**
 * Filer.db's own single-row identity/provenance record rather than the layer-interface `layer_manifest`,
 * because filer.db is deliberately not a layer-interface artifact (no coordinates until ASR lands).
 */
export interface FilerManifestTable {
	name: string
	version: string
	schema_version: number
	/**
	 * E.g.
	 *
	 * `form-499,bdc-provider-list`; filer.db draws from multiple sources at once,
	 * unlike a single-source layer.
	 */
	source: string
	source_vintage: string
	build_cmd: string
	build_sha: string
	created_at: string
}

export interface FilerDatabase {
	filer_node: FilerNodeTable
	filer_edge: FilerEdgeTable
	filer_attribute: FilerAttributeTable
	filer_cluster: FilerClusterTable
	filer_family: FilerFamilyTable
	filer_manifest: FilerManifestTable
}

/**
 * Create `filer_node` as a plain rowid table, because a single-column text PK
 * has no second column to cluster in alongside it.
 */
export async function createFilerNodeTable(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema
		.createTable("filer_node")
		.addColumn("node_id", "text", (c) => c.primaryKey())
		.addColumn("identifier_type", "text", (c) => c.notNull())
		.addColumn("identifier_value", "text", (c) => c.notNull())
		.execute()
}

/**
 * Create `filer_edge` with the composite PK `(from_node_id, to_node_id, source, valid_from)`,
 * a plain rowid table because `evidence` is unbounded JSON and the dominant read is a range scan.
 *
 * `relationship` is deliberately not part of the primary key: the PK's job is telling
 * apart different provenance, where two rows are legitimate, but one source asserting
 * both `same_entity` and `holding_company` for the same pair at the same instant is
 * a contradiction the composite `unique` index makes SQLite reject.
 *
 * A check constraint additionally rejects a blank/whitespace-only `relationship`,
 * which `not NULL` alone does not.
 *
 * Call {@link createFilerEdgeToNodeIndex} separately after bulk load for the reverse traversal path.
 */
export async function createFilerEdgeTable(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema
		.createTable("filer_edge")
		.addColumn("from_node_id", "text", (c) => c.notNull())
		.addColumn("to_node_id", "text", (c) => c.notNull())
		.addColumn("assertion", "text", (c) => c.notNull())
		.addColumn("relationship", "text", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("source_vintage", "text", (c) => c.notNull())
		.addColumn("valid_from", "text", (c) => c.notNull())
		.addColumn("valid_to", "text")
		.addColumn("match_score", "real")
		.addColumn("evidence", "text")
		.addPrimaryKeyConstraint("filer_edge_pk", ["from_node_id", "to_node_id", "source", "valid_from"])
		.addCheckConstraint("filer_edge_relationship_not_blank", sql`trim(relationship) != ''`)
		.execute()
}

/**
 * Secondary index for the reverse in-edges traversal path; the composite PK's leading column
 * is `from_node_id`, so a `to_node_id` lookup needs its own index, created after bulk load.
 */
export async function createFilerEdgeToNodeIndex(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema.createIndex("filer_edge_to_node_id").on("filer_edge").column("to_node_id").execute()
}

/**
 * Create `filer_attribute`; call {@link createFilerAttributeNodeIndex} separately
 * after bulk load for the `all attributes of this node` lookup path.
 */
export async function createFilerAttributeTable(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema
		.createTable("filer_attribute")
		.addColumn("node_id", "text", (c) => c.notNull())
		.addColumn("key", "text", (c) => c.notNull())
		.addColumn("value", "text", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("source_vintage", "text", (c) => c.notNull())
		.execute()
}

/**
 * Secondary index for the `all attributes of this node` lookup path, created after bulk load.
 */
export async function createFilerAttributeNodeIndex(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema.createIndex("filer_attribute_node_id").on("filer_attribute").column("node_id").execute()
}

/**
 * Create `filer_cluster`; call {@link createFilerClusterIndex} separately
 * after bulk load for the `all members of this cluster` lookup path.
 */
export async function createFilerClusterTable(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema
		.createTable("filer_cluster")
		.addColumn("node_id", "text", (c) => c.notNull())
		.addColumn("cluster_id", "text", (c) => c.notNull())
		.addColumn("assertion", "text", (c) => c.notNull())
		.execute()
}

/**
 * Secondary index for the `all members of this cluster` lookup path, created after bulk load.
 */
export async function createFilerClusterIndex(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema.createIndex("filer_cluster_cluster_id").on("filer_cluster").column("cluster_id").execute()
}

/**
 * Create `filer_family` with the composite PK `(node_id, family_id, naming_node_id, source, valid_from)`,
 * mirroring {@link createFilerEdgeTable}'s reasoning: the PK tells apart provenance, and both
 * `relationship` and `assertion` are deliberately excluded because one source grading the identical
 * membership two ways at one instant is a contradiction to reject rather than a plurality to store.
 *
 * `naming_node_id` is in the key and must stay there: two raw spellings can canonicalize
 * to the same `family_id`, and left out of the key their identical PK tuple would let
 * the builder's `insert or ignore` silently drop the second spelling's display name
 * from every rollup, against the SDK's expose-the-plurality-never-guess rule.
 *
 * Blank-rejecting checks cover `relationship` and `assertion`, because `not NULL` alone accepts
 * the empty string and a blank assertion matches neither half of every criterion-2 read; `match_score`
 * may appear only on an inferred row, since an authoritative membership matched no candidate.
 *
 * Call {@link createFilerFamilyIndex} separately after bulk load for the
 * `all members of this family` lookup path.
 */
export async function createFilerFamilyTable(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema
		.createTable("filer_family")
		.addColumn("node_id", "text", (c) => c.notNull())
		.addColumn("family_id", "text", (c) => c.notNull())
		.addColumn("naming_node_id", "text", (c) => c.notNull())
		.addColumn("assertion", "text", (c) => c.notNull())
		.addColumn("relationship", "text", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("source_vintage", "text", (c) => c.notNull())
		.addColumn("valid_from", "text", (c) => c.notNull())
		.addColumn("valid_to", "text")
		.addColumn("match_score", "real")
		.addPrimaryKeyConstraint("filer_family_pk", ["node_id", "family_id", "naming_node_id", "source", "valid_from"])
		.addCheckConstraint("filer_family_relationship_not_blank", sql`trim(relationship) != ''`)
		.addCheckConstraint("filer_family_assertion_not_blank", sql`trim(assertion) != ''`)
		// sql.lit rather than a bound parameter: SQLite's DDL cannot carry one, and the literal is derived from FilerEdgeAssertion rather than hand-typed so the constraint and the const can never drift apart.
		.addCheckConstraint(
			"filer_family_match_score_inferred_only",
			sql`match_score is null or assertion = ${sql.lit(FilerEdgeAssertion.Inferred)}`
		)
		.execute()
}

/**
 * Secondary index for the `all members of this family` lookup path; the composite PK's leading
 * column is `node_id`, so a `family_id` lookup needs its own index, created after bulk load.
 */
export async function createFilerFamilyIndex(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema.createIndex("filer_family_family_id").on("filer_family").column("family_id").execute()
}

/**
 * Create `filer_manifest`, a single row enforced by its `name` PK plus the writer's
 * insert-once discipline and {@link readFilerManifest}'s throw-unless-exactly-one read.
 */
export async function createFilerManifestTable(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema
		.createTable("filer_manifest")
		.addColumn("name", "text", (c) => c.primaryKey())
		.addColumn("version", "text", (c) => c.notNull())
		.addColumn("schema_version", "integer", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("source_vintage", "text", (c) => c.notNull())
		.addColumn("build_cmd", "text", (c) => c.notNull())
		.addColumn("build_sha", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.execute()
}

/**
 * Read and validate the manifest with `readLayerManifest`'s throw-unless-exactly-one discipline
 * but none of its layer-interface validation, which does not apply to filer.db's own manifest.
 */
export async function readFilerManifest(db: Kysely<FilerDatabase>): Promise<FilerManifestTable> {
	const rows = await db.selectFrom("filer_manifest").selectAll().execute()

	if (rows.length !== 1) {
		throw new Error(`filer manifest: expected exactly 1 row, found ${rows.length}`)
	}

	return rows[0]!
}
