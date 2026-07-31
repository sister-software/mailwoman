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
 *   nodes — "this FRN and this SPIN are the same filer" — as reported by one source at one vintage.
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
 */

import type { Kysely } from "kysely"

/**
 * The identifier namespaces a `filer_node.node_id` can be minted from. No enum (repo rule): `FRN` and `Form499ID` come
 * from the FCC Form 499 filer database (3a decisions 3, 8); `SPIN` and `BDCProviderID` come from the BDC provider list
 * (decision 6); `HoldingCompanyName` and `ManagementCompanyName` cover free-text fields on either source that carry no
 * stable ID of their own.
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
 * directly (e.g. a Form 499 filing lists both an FRN and a SPIN for the same filer). `Inferred` — derived by matching
 * (name/address comparators); carries `match_score` and `evidence`.
 */
export const FilerEdgeAssertion = {
	Authoritative: "authoritative",
	Inferred: "inferred",
} as const

export type FilerEdgeAssertion = (typeof FilerEdgeAssertion)[keyof typeof FilerEdgeAssertion]

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
	 * Null while the assertion is still in force.
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
 */
export async function createFilerEdgeTable(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema
		.createTable("filer_edge")
		.addColumn("from_node_id", "text", (c) => c.notNull())
		.addColumn("to_node_id", "text", (c) => c.notNull())
		.addColumn("assertion", "text", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("source_vintage", "text", (c) => c.notNull())
		.addColumn("valid_from", "text", (c) => c.notNull())
		.addColumn("valid_to", "text")
		.addColumn("match_score", "real")
		.addColumn("evidence", "text")
		.addPrimaryKeyConstraint("filer_edge_pk", ["from_node_id", "to_node_id", "source", "valid_from"])
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
