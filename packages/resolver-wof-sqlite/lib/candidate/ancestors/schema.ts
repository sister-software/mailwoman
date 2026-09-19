/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the candidate gazetteer's ancestors sidecar (`candidate_ancestor` +
 *   `candidate_interval`) — the containment lineage the candidate table itself cannot answer, built
 *   into the same `candidate.db` by `build-candidate.ts` and read by
 *   {@link WOFCandidateTableLookup.ancestors}.
 *
 *   encoding: closure-lite rows, denormalized — one row per (place, ancestor) edge carrying the
 *   parent's placetype, display name and folded key — rather than a fixed-slot id chain on the
 *   candidate row. Decided by the two consumers:
 *
 *   1. The admin-coherence check needs the winner's chain as (placetype, name) pairs in one probe.
 *      A fixed-slot `[id.8]` chain answers with ids, and every id then needs a name lookup the
 *      artifact has no per-id table for — up to 8 indirections where the closure row has zero.
 *   2. The account layer needs every candidate under a `name_key` enumerable with its chain from
 *      one artifact probe ("present-but-outranked, discriminated by containment"). That is the
 *      candidate probe (contiguous) followed by one `spr_id`-clustered closure probe per candidate
 *      — each a handful of adjacent pages.
 *
 *   Denormalizing the parent onto the edge is the same discipline as the candidate table itself:
 *   this artifact is read over http byte ranges, where a join to a dimension table scatters page
 *   fetches, and a `without rowid` B-tree clustered on `(spr_id, depth)` keeps a whole chain in
 *   1-2 pages. The repeated parent strings are the price of the zero-join read, paid at build time.
 *
 *   `depth` is 1 for the nearest ancestor (deepest containment tier), increasing outward to the
 *   country — the same nearest-first order `ancestry.ts` serves for the FTS backend, so the two
 *   backends' `ancestors()` agree by construction. The order within a place is deterministic:
 *   containment depth descending (`placetypeDepth`), then ancestor id ascending, capped at
 *   {@link MAX_ANCESTOR_DEPTH}. `parent_name_key` is the shared {@link normalizeLocalityForKey}
 *   fold — the same fold `candidate.name_key` is built with, so a chain entry and a candidate key
 *   compare under one normalizer.
 *
 *   `candidate_interval` carries pre/post-order labels over the canonical-parent forest, assigned
 *   at build time: `a` contains `d` ⟺ `a.pre <= d.pre and d.post <= a.post` — O(1) in either
 *   direction with no chain scan and no knowledge of either side's tier — and the descendants of
 *   `a` are the contiguous range `pre between a.pre and a.post`. Interval labels are classically
 *   avoided for their relabel-on-update cost. this database is a sealed read-only artifact rebuilt
 *   whole, which is exactly the regime where that cost is void.
 *
 *   the DAG caveat, and the recorded choice: WOF places can carry more than one parent (multiple
 *   hierarchies, ambiguous boundaries). `candidate_ancestor` keeps every parent — the closure rows
 *   are the complete containment record. A single interval pair can only encode a tree, so the
 *   interval forest links each place to one canonical parent: its depth-1 edge — the finest
 *   containment tier, lowest ancestor id — the same MIN-stability convention the candidate table's
 *   `region_id` stamp uses. A containment question about a NON-canonical hierarchy must consult the
 *   closure rows. the interval answer for it is `false`, which is why interval verdicts are
 *   "contained along the canonical hierarchy", never "not contained at all".
 *
 *   absence semantics (meaning-of-zero): a place with no `candidate_interval` row has no recorded
 *   ancestry in the source (extract-fed postcodes and localities, isolated places, cycle-skipped
 *   rows). Absence is unverifiable, never a containment verdict.
 */

import { sql, type Kysely } from "kysely"

// Type-only and circular on purpose (candidate-schema extends CandidateAncestorsDatabase): Kysely's
// DB parameter is invariant, so the DDL functions must take the full database type their caller
// holds. Erased at runtime.
import type { CandidateDatabase } from "#candidate/schema"
import type { NameKey } from "#street/normalize"

/**
 * The deepest chain the sidecar stores per place. WOF containment within the resolvable placetypes (country …
 * microhood) never legitimately exceeds this. anything past it is source noise the build drops (and counts) rather than
 * stores.
 */
export const MAX_ANCESTOR_DEPTH = 8

/**
 * The closure-row table's name — probed with `hasTable` by the reader, so an artifact predating the sidecar degrades to
 * "no ancestors capability" rather than `no such table`.
 */
export const CANDIDATE_ANCESTOR_TABLE = "candidate_ancestor"

/**
 * The interval-label table's name — the closure table's seal-time sibling. existence-restricted the same way.
 */
export const CANDIDATE_INTERVAL_TABLE = "candidate_interval"

/**
 * One (place, ancestor) edge, denormalized so a chain read is a single clustered probe (no join).
 */
export interface CandidateAncestorTable {
	/**
	 * WOF id of the place whose chain this row belongs to — the same `spr_id` the candidate table resolves to.
	 */
	spr_id: number
	/**
	 * 1 = nearest ancestor, increasing outward to the country. Deterministic within a place (containment depth
	 * descending, then ancestor id ascending), so `(spr_id, depth)` is a stable primary key across rebuilds.
	 */
	depth: number
	/**
	 * WOF id of the ancestor.
	 */
	parent_spr_id: number
	/**
	 * Small int from the shared `placetype_codes` dictionary (the same one the candidate table uses).
	 */
	parent_placetype_id: number
	/**
	 * The ancestor's canonical display name — what {@link Ancestor.name} serves, matching the FTS backend's register.
	 */
	parent_name: string
	/**
	 * The shared {@link normalizeLocalityForKey} fold of `parent_name` — comparable against `candidate.name_key` and
	 * against a query-side fold under one normalizer, by construction.
	 */
	parent_name_key: NameKey
}

/**
 * Pre/post-order labels over the canonical-parent forest — one row per place with recorded ancestry (see the module
 * docstring for absence semantics). `pre < post` always. labels are unique across the artifact.
 */
export interface CandidateIntervalTable {
	spr_id: number
	pre: number
	post: number
}

/**
 * The sidecar tables, for a `Kysely` view over the candidate DB. `CandidateDatabase` (candidate-schema.ts) extends
 * this, so the builder's one typed client sees both families.
 */
export interface CandidateAncestorsDatabase {
	candidate_ancestor: CandidateAncestorTable
	candidate_interval: CandidateIntervalTable
}

/**
 * The `candidate_ancestor` columns in clustered-key order — the first two are the primary key, and the builder's
 * positional `insert` binds by this order. Keep in sync with {@link CandidateAncestorTable}.
 */
export const CANDIDATE_ANCESTOR_COLUMNS = [
	"spr_id",
	"depth",
	"parent_spr_id",
	"parent_placetype_id",
	"parent_name",
	"parent_name_key",
] as const

/**
 * Create the clustered closure table. The builder inserts in `(spr_id, depth)` order so the B-tree leaves are
 * contiguous per place — the byte-range read discipline.
 */
export async function createCandidateAncestorTable(db: Kysely<CandidateDatabase>): Promise<void> {
	await db.schema
		.createTable(CANDIDATE_ANCESTOR_TABLE)
		.addColumn("spr_id", "integer", (c) => c.notNull())
		.addColumn("depth", "integer", (c) => c.notNull())
		.addColumn("parent_spr_id", "integer", (c) => c.notNull())
		.addColumn("parent_placetype_id", "integer", (c) => c.notNull())
		.addColumn("parent_name", "text", (c) => c.notNull())
		.addColumn("parent_name_key", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("candidate_ancestor_pk", ["spr_id", "depth"])
		// `without rowid` has no first-class builder. the raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Create the interval-label table. Small rows probed by primary key — the `without rowid` win case.
 */
export async function createCandidateIntervalTable(db: Kysely<CandidateDatabase>): Promise<void> {
	await db.schema
		.createTable(CANDIDATE_INTERVAL_TABLE)
		.addColumn("spr_id", "integer", (c) => c.primaryKey())
		.addColumn("pre", "integer", (c) => c.notNull())
		.addColumn("post", "integer", (c) => c.notNull())
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * One place's interval label — the shape both sides of a containment comparison read.
 */
export interface IntervalLabel {
	pre: number
	post: number
}

/**
 * Does `outer` contain `inner` along the canonical hierarchy? Reflexive: a place contains itself (containment
 * degenerates to identity, the same reading the admin-coherence check gives a self-match). The shared function for
 * every consumer of the labels — a re-derived comparison risks disagreeing at exactly the strict/inclusive boundary
 * this line settles.
 */
export function intervalContains(outer: IntervalLabel, inner: IntervalLabel): boolean {
	return outer.pre <= inner.pre && inner.post <= outer.post
}
