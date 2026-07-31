/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for filer.db — the identity crosswalk read-side layer (Phase 3a decisions 2, 6, 7).
 *   Deliberately NOT a layer-contract artifact (decision 2): filer.db has no coordinate references until
 *   ASR arrives in Phase 3c, and `@mailwoman/core/layers`' `layer_coverage` is H3-keyed, so conforming
 *   to that contract would mean writing coverage rows that assert nothing. Instead `filer_manifest` is
 *   filer.db's own single-row identity/provenance record — see {@link readFilerManifest}, which copies
 *   `readLayerManifest`'s (`core/layers/manifest.ts`) throw-unless-exactly-one discipline without
 *   reusing its table or its tier/freshness-policy/spine-key validation, none of which apply here.
 *
 *   `filer_node` is the crosswalk's join surface: one row per identifier instance (an FRN, a Form 499
 *   ID, a SPIN, a BDC `provider_id`, a holding- or management-company name), keyed on the synthetic
 *   `node_id = "${identifier_type}:${identifier_value}"`. `filer_edge` asserts a relationship between two
 *   nodes — "this FRN and this Form 499 ID are the same filer" — as reported by one source at one
 *   vintage. (`SPIN` is a reserved identifier namespace — see {@link FilerIdentifierType}'s own docstring
 *   for why it carries no populated node in 3a.)
 *
 *   Decision 7 / gate 1 (load-bearing): `valid_from` is MANDATORY on every edge (`valid_to` is the
 *   nullable half of the pair), and the primary key is the 4-tuple `(from_node_id, to_node_id, source,
 *   valid_from)`, NOT just `(from_node_id, to_node_id)`. Two sources asserting the same relationship, or
 *   one source revising its assertion at a later vintage, produce two rows rather than a silent
 *   overwrite — that plurality is the entire point of carrying provenance. `FilerEdgeTable` has no
 *   `Generated<>`-wrapped columns, so Kysely's `Insertable<FilerEdgeTable>` requires every field
 *   (including the nullable ones, which must be passed as an explicit `null`) — an edge insert missing
 *   `source`, `source_vintage`, `assertion`, or `valid_from` is a compile error, not a runtime surprise.
 *
 *   Clustering: `filer_edge`'s primary key is enforced as a plain composite `UNIQUE` index, NOT `WITHOUT
 *   ROWID` — `evidence` is an inferred-match JSON blob of unbounded size, the same anti-pattern
 *   `bdc/schema.ts` calls out for `bdc_availability`'s wider columns, and the dominant read pattern (all
 *   edges out of, or into, one node) is a range scan, not a single composite-key point probe.
 *   `filer_node`'s single-column TEXT primary key stays a plain rowid table too, matching
 *   `layer_manifest.name`'s precedent — there's no second column to fold into the B-tree alongside it,
 *   and reconstructing `node_id` from a known `(identifier_type, identifier_value)` pair IS the lookup
 *   path, so there's no secondary index for that reverse direction either.
 *
 *   **3b Task 1 additions (decisions 1, 2; `schema_version` bumped to 2 in the manifest write path,
 *   `build-filer.ts`):** {@link FilerEdgeAssertion} grades HOW STRONGLY an assertion is evidenced
 *   (authoritative vs. inferred) — it says nothing about WHAT the assertion means. `filer_edge` gains a
 *   separate, orthogonal `relationship` column ({@link FilerRelationship}) for that: before this column
 *   existed, relationship kind lived implicitly in the TARGET node's `identifier_type` (an edge into a
 *   `holding_company_name` node was "assumed" to mean ownership), a scheme that cannot distinguish a
 *   holding company from a parent CIK from a transfer-of-control. `relationship` is NOT part of
 *   `filer_edge`'s primary key (deliberately — see {@link createFilerEdgeTable}'s docstring): one source
 *   asserting two different relationship kinds for the same pair at the same instant is a contradiction
 *   to reject, not a plurality to store the way two DIFFERENT sources (or vintages) are.
 *
 *   `filer_cluster` also conflated two distinct rollups the spec keeps apart: an ENTITY cluster (same
 *   underlying filer under different identifiers — what `filer_cluster` has always meant) and a
 *   CORPORATE FAMILY (a holding/parent/subsidiary/management tree spanning several DIFFERENT filers).
 *   `filer_family` is the new seam for the latter — see {@link FilerFamilyTable}. Its own primary key
 *   mirrors `filer_edge`'s reasoning exactly (composite on `(node_id, family_id, source, valid_from)`,
 *   `relationship` excluded from it for the identical contradiction-vs-plurality reason).
 */

import { sql, type Kysely } from "kysely"

/**
 * The identifier namespaces a `filer_node.node_id` can be minted from. No enum (repo rule): `FRN` and `Form499ID` come
 * from the FCC Form 499 filer database (3a decisions 3, 8); `BDCProviderID` comes from the BDC provider list (decision
 * 6); `HoldingCompanyName` and `ManagementCompanyName` cover free-text fields on either source that carry no stable ID
 * of their own.
 *
 * `SPIN` is DEFINED here but UNPOPULATED in 3a (review fix, minor — a prior docstring here incorrectly implied it was
 * sourced from the provider list or a 499 row): neither of `filer/sdk`'s two 3a parsers (`form499.ts`'s `Form499Row`,
 * `provider-list.ts`'s `ProviderListRow`) carries a SPIN field, and `build-filer.ts` mints no `spin:` node — there is
 * no code path in this phase that populates one. The namespace is reserved for whichever future task adds a source that
 * actually carries a SPIN, not a claim that any `filer.db` `buildFilerDatabase` produces today has SPIN nodes in it.
 */
export const FilerIdentifierType = {
	FRN: "frn",
	Form499ID: "form499_id",
	SPIN: "spin",
	BDCProviderID: "bdc_provider_id",
	HoldingCompanyName: "holding_company_name",
	ManagementCompanyName: "management_company_name",
} as const

export type FilerIdentifierType = (typeof FilerIdentifierType)[keyof typeof FilerIdentifierType]

/**
 * How a `filer_edge` relationship was established. `Authoritative` — the source document states the relationship
 * directly (e.g. a Form 499 filing lists both an FRN and a Form 499 ID for the same filer). `Inferred` — derived by
 * matching (name/address comparators); carries `match_score` and `evidence`.
 */
export const FilerEdgeAssertion = {
	Authoritative: "authoritative",
	Inferred: "inferred",
} as const

export type FilerEdgeAssertion = (typeof FilerEdgeAssertion)[keyof typeof FilerEdgeAssertion]

/**
 * The KIND of relationship a `filer_edge` or `filer_family` row asserts between two nodes (3b Task 1, decisions 1, 2) —
 * orthogonal to {@link FilerEdgeAssertion}, which grades how strongly the SAME assertion is evidenced, never what it
 * means. Before this column existed, relationship kind lived implicitly in the TARGET node's `identifier_type` (e.g. an
 * edge into a `holding_company_name` node was "assumed" to mean ownership) — a scheme that cannot distinguish a holding
 * company from a parent CIK from a transfer-of-control, and had no way to express a corporate-family fact
 * (`filer_family`) at all.
 *
 * - `SameEntity` — the two nodes denote the SAME underlying filer under different identifiers (an FRN and its Form 499
 *   ID, a BDC `provider_id` and its FRN) — the crosswalk's original, still-dominant edge meaning, and the only kind
 *   {@link FilerNodeTable} entity-clustering (`cluster-filers.ts`) ever asserts.
 * - `HoldingCompany` — the target node is the source node's holding company (an ownership fact).
 * - `ManagementCompany` — the target node operates/manages the source node without owning it — operational control, never
 *   collapsed into `HoldingCompany` (spec §3.1 finding 1: ownership and operational control are different assertions).
 * - `ParentCompany` — the target is the source's parent in a corporate-family rollup ({@link FilerFamilyTable}), distinct
 *   from `HoldingCompany`: a parent-company relationship is a family-tree fact, not necessarily an ownership filing.
 * - `Subsidiary` — the inverse of `ParentCompany`, kept as its own value (never just "read backwards") so a row's
 *   `relationship` always describes the edge in the direction it was asserted, without requiring the reader to know
 *   which side is the source.
 */
export const FilerRelationship = {
	SameEntity: "same_entity",
	HoldingCompany: "holding_company",
	ManagementCompany: "management_company",
	ParentCompany: "parent_company",
	Subsidiary: "subsidiary",
} as const

export type FilerRelationship = (typeof FilerRelationship)[keyof typeof FilerRelationship]

/**
 * One identifier instance in the crosswalk. See the file header for why `node_id` needs no secondary index on
 * `(identifier_type, identifier_value)`.
 */
export interface FilerNodeTable {
	/**
	 * PK. `` `${identifier_type}:${identifier_value}` ``.
	 */
	node_id: string
	/**
	 * One of {@link FilerIdentifierType}.
	 */
	identifier_type: string
	identifier_value: string
}

/**
 * One source's assertion, at one vintage, that two nodes denote the same filer. See the file header for the
 * composite-PK provenance-plurality rationale (decision 7 / gate 1).
 */
export interface FilerEdgeTable {
	from_node_id: string
	to_node_id: string
	/**
	 * One of {@link FilerEdgeAssertion}.
	 */
	assertion: string
	/**
	 * One of {@link FilerRelationship} (3b Task 1, decisions 1, 2). Orthogonal to `assertion` — see the file header and
	 * {@link FilerRelationship}'s own docstring. NOT part of {@link createFilerEdgeTable}'s primary key: see that
	 * function's docstring for why a same-instant conflicting `relationship` from one source is a contradiction to
	 * reject, not a plurality to store.
	 */
	relationship: string
	/**
	 * E.g. `"form-499"`, `"bdc-provider-list"`.
	 */
	source: string
	/**
	 * File vintage / filing date of the source this assertion came from.
	 */
	source_vintage: string
	/**
	 * MANDATORY (decision 7 / gate 1) — every edge asserts a start of validity, even an authoritative one lifted straight
	 * from a filing (use the filing's vintage/date when no finer-grained date exists).
	 */
	valid_from: string
	/**
	 * Null while the assertion is still in force. When set, the validity window is HALF-OPEN: `valid_from <= t <
	 * valid_to` — `valid_to` is the first date the assertion no longer holds, not the last date it did.
	 *
	 * This is forced, not a stylistic choice: `cluster-filers.ts`'s cross-vintage supersession closes a superseded
	 * inferred edge with `SET valid_to = sourceVintage` (`cluster-filers.ts`:577) in the SAME transaction that inserts
	 * its replacement at `valid_from = sourceVintage` (`cluster-filers.ts`:611) — the identical date on both sides of the
	 * changeover. A closed (inclusive-inclusive, `valid_from <= t <= valid_to`) convention would make the closed row and
	 * its replacement BOTH claim to be in force on `sourceVintage` itself, double-counting that one date. Every reader
	 * that scopes a query `asOf` a date (see `filer/sdk/filer-lookup.ts`'s `filerLookup`) must apply the matching
	 * half-open predicate — `valid_from <= asOf AND (valid_to IS NULL OR asOf < valid_to)` — or it will silently disagree
	 * with what the writer actually guaranteed at a changeover boundary.
	 */
	valid_to: string | null
	/**
	 * Inferred only; null for authoritative assertions.
	 */
	match_score: number | null
	/**
	 * JSON-encoded match evidence. Inferred only; null for authoritative assertions.
	 */
	evidence: string | null
}

/**
 * A key/value fact about a node — e.g. a brand name or an address captured as free text rather than a graph edge.
 * Provenance-plural like `filer_edge`: the same `(node_id, key)` reported by two sources produces two rows, not a
 * clobber.
 */
export interface FilerAttributeTable {
	node_id: string
	key: string
	value: string
	source: string
	source_vintage: string
}

/**
 * Cluster membership: which entity cluster a node has been assigned to, and whether that assignment is authoritative or
 * inferred (mirrors {@link FilerEdgeAssertion}).
 */
export interface FilerClusterTable {
	node_id: string
	cluster_id: string
	/**
	 * One of {@link FilerEdgeAssertion}.
	 */
	assertion: string
}

/**
 * Corporate-family membership (3b Task 1, decisions 1, 2) — the seam `filer_cluster` never had for telling apart an
 * ENTITY cluster (same filer, different identifiers — `filer_cluster`'s own, unchanged meaning) from a CORPORATE FAMILY
 * (a holding/parent/subsidiary/management tree spanning several DIFFERENT filers). One row asserts that `node_id`
 * belongs to `family_id` under a specific {@link FilerRelationship} `relationship`, as reported by one source at one
 * vintage — provenance-plural and temporally scoped exactly like `filer_edge` (see {@link createFilerFamilyTable}'s
 * docstring for why its primary key mirrors `filer_edge`'s reasoning, `relationship` excluded, and the file header for
 * the half-open `valid_from <= t < valid_to` convention `valid_to` follows here too).
 */
export interface FilerFamilyTable {
	node_id: string
	family_id: string
	/**
	 * One of {@link FilerRelationship}.
	 */
	relationship: string
	source: string
	source_vintage: string
	valid_from: string
	/**
	 * Half-open, exactly like {@link FilerEdgeTable.valid_to} — see the file header.
	 */
	valid_to: string | null
}

/**
 * Filer.db's own single-row identity/provenance record (decision 2) — NOT the layer-contract `layer_manifest` from
 * `@mailwoman/core/layers`; filer.db is deliberately not a layer-contract artifact in 3a (no coordinates until ASR
 * lands in Phase 3c). See {@link readFilerManifest} for the single-row read discipline.
 */
export interface FilerManifestTable {
	/**
	 * PK.
	 */
	name: string
	version: string
	schema_version: number
	/**
	 * E.g. `"form-499,bdc-provider-list"` — filer.db draws from multiple sources at once, unlike a single-source layer.
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
 * Create `filer_node`. Plain rowid table — see the file header for why a single-column TEXT PK doesn't earn `WITHOUT
 * ROWID` here (no second column to cluster in alongside it).
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
 * Create `filer_edge` with the composite PK `(from_node_id, to_node_id, source, valid_from)` — see the file header for
 * the provenance-plurality rationale (decision 7 / gate 1) and why this stays a plain rowid table rather than `WITHOUT
 * ROWID`. Call {@link createFilerEdgeToNodeIndex} separately, after bulk load, for the reverse (in-edges) traversal
 * path.
 *
 * `relationship` (3b Task 1, decisions 1, 2) is deliberately NOT part of the primary key, even though it's every bit as
 * load-bearing as `assertion`: the PK's job is telling apart DIFFERENT provenance (a different source, or the same
 * source at a later vintage) — two rows are a legitimate plurality there. Two rows from the SAME source at the SAME
 * `valid_from` for the SAME pair is a different situation: if `relationship` were in the key, one source could assert
 * BOTH `"same_entity"` and `"holding_company"` for the identical `(from, to)` pair at the identical instant, and both
 * would silently persist side by side. That's a contradiction (one source, one moment, two incompatible claims about
 * what the pair means), not a provenance plurality — the composite `UNIQUE` index leaving `relationship` out is what
 * makes SQLite reject the second insert instead of quietly storing it. A CHECK constraint additionally rejects a
 * blank/whitespace-only `relationship` — `NOT NULL` alone doesn't (SQLite happily stores `""`), the same gap
 * `assertLastFiledAt`/`assertISODate` exist to close for the temporal columns.
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
 * Secondary index for the reverse (in-edges) traversal path — the composite PK's leading column is `from_node_id`, so a
 * `to_node_id` lookup needs its own index. Index-after-load, same discipline as `bdc_availability`'s geoid index (see
 * `bdc/schema.ts`'s {@link createBDCGeoidIndex} companion).
 */
export async function createFilerEdgeToNodeIndex(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema.createIndex("filer_edge_to_node_id").on("filer_edge").column("to_node_id").execute()
}

/**
 * Create `filer_attribute`. Call {@link createFilerAttributeNodeIndex} separately, after bulk load, for the "all
 * attributes of this node" lookup path.
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
 * Secondary index for the "all attributes of this node" lookup path. Index-after-load.
 */
export async function createFilerAttributeNodeIndex(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema.createIndex("filer_attribute_node_id").on("filer_attribute").column("node_id").execute()
}

/**
 * Create `filer_cluster`. Call {@link createFilerClusterIndex} separately, after bulk load, for the "all members of
 * this cluster" lookup path.
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
 * Secondary index for the "all members of this cluster" lookup path. Index-after-load.
 */
export async function createFilerClusterIndex(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema.createIndex("filer_cluster_cluster_id").on("filer_cluster").column("cluster_id").execute()
}

/**
 * Create `filer_family` with the composite PK `(node_id, family_id, source, valid_from)` — mirrors
 * {@link createFilerEdgeTable}'s reasoning exactly: the PK's job is telling apart DIFFERENT provenance (a different
 * source, or the same source at a later vintage), and `relationship` is deliberately excluded from it for the same
 * contradiction-vs-plurality reason — one source asserting BOTH `"parent_company"` and `"subsidiary"` for the identical
 * `(node_id, family_id)` pair at the identical instant is a contradiction to reject, not a plurality to store. The same
 * blank/whitespace-rejecting CHECK constraint applies to `relationship` here too. Call {@link createFilerFamilyIndex}
 * separately, after bulk load, for the "all members of this family" lookup path.
 */
export async function createFilerFamilyTable(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema
		.createTable("filer_family")
		.addColumn("node_id", "text", (c) => c.notNull())
		.addColumn("family_id", "text", (c) => c.notNull())
		.addColumn("relationship", "text", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("source_vintage", "text", (c) => c.notNull())
		.addColumn("valid_from", "text", (c) => c.notNull())
		.addColumn("valid_to", "text")
		.addPrimaryKeyConstraint("filer_family_pk", ["node_id", "family_id", "source", "valid_from"])
		.addCheckConstraint("filer_family_relationship_not_blank", sql`trim(relationship) != ''`)
		.execute()
}

/**
 * Secondary index for the "all members of this family" lookup path — the composite PK's leading column is `node_id`, so
 * a `family_id` lookup needs its own index, exactly matching {@link createFilerClusterIndex}'s rationale.
 * Index-after-load.
 */
export async function createFilerFamilyIndex(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema.createIndex("filer_family_family_id").on("filer_family").column("family_id").execute()
}

/**
 * Create `filer_manifest`. Single row enforced the same way `layer_manifest` is: a PK (here `name`) plus the writer's
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
 * Read + validate the manifest. Copies `readLayerManifest`'s (`core/layers/manifest.ts`) throw-unless- exactly-one
 * discipline WITHOUT its table or its tier/freshness-policy/spine-key validation — none of those layer-contract
 * invariants apply to filer.db's own manifest (decision 2).
 */
export async function readFilerManifest(db: Kysely<FilerDatabase>): Promise<FilerManifestTable> {
	const rows = await db.selectFrom("filer_manifest").selectAll().execute()

	if (rows.length !== 1) {
		throw new Error(`filer manifest: expected exactly 1 row, found ${rows.length}`)
	}

	return rows[0]!
}
