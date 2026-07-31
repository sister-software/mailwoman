/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Entity clustering over an already-built `filer.db` (3a Task 6, decisions 4, 5). TWO passes, kept
 *   deliberately apart (decision 5):
 *
 *   **(a) Authoritative components** ({@linkcode clusterAuthoritativeComponents}) — every
 *   `filer_edge` row asserted `"authoritative"` (Task 5's builder — a source document stating the
 *   relationship directly) is fed to {@linkcode cluster} (`@mailwoman/match`) as a
 *   {@linkcode ScoredLink} with `weight: Infinity` — an authoritative edge is never in doubt, so ANY
 *   finite `threshold` unions it. The resulting connected components are written to `filer_cluster`
 *   with `assertion: "authoritative"`.
 *
 *   **(b) Inferred links** ({@linkcode clusterInferredLinks}) — one {@linkcode SourceRecord}
 *   (`@mailwoman/registry`) per `form499_id` node that carries a `legal_name` attribute:
 *   `organization` is {@linkcode canonicalizeOrganizationName}'s reduction of that name
 *   (`@mailwoman/record`); `attributes.frn` / `.form499ID` / `.providerID` are whitespace-joined
 *   CODE SETS of every identifier value already sharing that node's AUTHORITATIVE component (pass
 *   (a)'s own grouping is reused here purely as the feature basis for pass (b) — not as a write
 *   target). {@linkcode resolveEntities} (`@mailwoman/registry`) is called with
 *   `learnedScorer: false` — **decision 4, BINDING**: the bundled scorer is a GBT trained on NPPES
 *   *healthcare* dedup, whose calibrated threshold is not in Fellegi-Sunter weight units and has no
 *   business scoring corporate legal names. Blocking is overridden to an exact match on the
 *   canonicalized organization name (`@mailwoman/match`'s default blocking keys are geo/address/
 *   phone/email — filer.db carries none of those until ASR lands in Phase 3c, decision 2 — so the
 *   library defaults would propose zero candidate pairs).
 *
 *   **Decision 5 / gate 2, BINDING and load-bearing:** an inferred link must NEVER alter an
 *   authoritative cluster assignment. This is not a runtime check on the inferred pass's output — it
 *   is a structural property of where each pass writes: (a) only ever touches `filer_cluster` rows
 *   `WHERE assertion = 'authoritative'`; (b) only ever touches rows `WHERE assertion = 'inferred'`
 *   (a disjoint set, by construction — every row this module writes carries the assertion it was
 *   computed under) plus `filer_edge` rows it itself asserts `'inferred'`. Passes (a) and (b) can run
 *   in either order, or only one at a time, without affecting each other's output — {@linkcode
 *   clusterInferredLinks} recomputes the authoritative grouping in memory (via the same
 *   {@linkcode cluster} call pass (a) makes) rather than reading pass (a)'s `filer_cluster` rows, so
 *   it has no write-order dependency on (a) having run first. `clusterFilers` runs both, in the
 *   documented order, purely for caller convenience.
 *
 *   **Idempotency (carried from Task 4/5 review): `filer_cluster` has no uniqueness constraint.**
 *   Unlike `filer_edge` (composite PK `(from_node_id, to_node_id, source, valid_from)`, Task 4) or
 *   `filer_attribute` (Task 5's staging-table dedup), `filer_cluster` has neither — Task 5 left it
 *   untouched (it writes nothing there; Task 4's review flagged it as a forward-looking concern for
 *   whichever task first populates it, which is this one). Both passes here make their OWN write
 *   idempotent the same way: inside one transaction, DELETE every row carrying that pass's
 *   `assertion` value, then INSERT the freshly computed set. Re-running either pass against
 *   unchanged input data reproduces byte-identical `(node_id, cluster_id)` rows (cluster ids are
 *   CONTENT-DERIVED — `` `${assertion}:${lexicographically-smallest member node_id}` `` — not
 *   index-based, so they don't depend on iteration order surviving between runs). `filer_edge`'s
 *   own composite PK already makes the inferred edges idempotent (`INSERT ... ON CONFLICT DO
 *   NOTHING`); Task 6 doesn't need to do anything extra there.
 *
 *   **Scope note:** only `form499_id` nodes carry a `legal_name` attribute (Task 5's builder never
 *   attaches attributes to `frn` / `bdc_provider_id` / holding- or management-company nodes), so
 *   those are the only nodes pass (b) can name-match. A provider that only ever appears in the BDC
 *   provider list (no corresponding Form 499 filing) has no legal name in this crosswalk and is
 *   invisible to the inferred pass — a real, documented gap, not an oversight.
 */

import { cluster, exactKey, type ScoredLink } from "@mailwoman/match"
import { canonicalizeOrganizationName } from "@mailwoman/record"
import { resolveEntities, type SourceRecord } from "@mailwoman/registry"
import type { Kysely } from "kysely"

import { FilerEdgeAssertion, FilerIdentifierType, type FilerClusterTable, type FilerDatabase } from "../schema.ts"

/**
 * `filer_edge.source` for every row {@linkcode clusterInferredLinks} writes — distinguishes this module's own
 * assertions from the ingest sources (`"form-499"`, `"bdc-provider-list"`).
 */
export const CLUSTER_FILERS_SOURCE = "cluster-filers"

/**
 * The attribute key {@linkcode clusterInferredLinks} reads to name-match `form499_id` nodes (Task 5's builder — see
 * `build-filer.ts`'s `stageAttribute(form499NodeID, "legal_name", ...)`).
 */
const LEGAL_NAME_ATTRIBUTE_KEY = "legal_name"

/**
 * Calibrated inferred-link threshold (match weight, in bits — {@link resolveEntities}'s `threshold`).
 *
 * `buildDefaultModel`'s prior (`lambda: 0.0001`) alone contributes `log2(0.0001 / 0.9999) ≈ -13.29` bits — a large,
 * constant tax on EVERY pair, since a match between two records drawn at random from the whole crosswalk is assumed
 * rare (the model was designed for the general case; it has no per-domain lambda lever). Because pass (b)'s blocking
 * key is an EXACT canonicalized-organization-name match, every candidate pair this module scores already carries the
 * organization comparison's `"exact"` level (`m: 0.8, u: 0.01` → `log2(80) ≈ +6.32` bits) — the identity signal
 * blocking selected FOR. `exactDiscriminators` (`frn`/`form499ID`/`providerID`) then contribute their OWN "different"
 * level (`m: 0.25, u: 0.92` → `log2(0.25/0.92) ≈ -1.88` bits EACH) whenever a candidate pair's code sets don't overlap
 * — which, for two DIFFERENT authoritative components, is the common case (their code sets are disjoint by
 * construction; components sharing a code would already be one authoritative component). Worst case, all three
 * discriminators disagree: `-13.29 + 6.32 - 3×1.88 ≈ -12.61` bits. `-13` sits just below that worst case (empirically
 * verified against `buildDefaultModel`'s current seed `m`/`u` constants — see the Task 6 report) while staying above
 * the zero-evidence floor (`-13.29`, reachable only by a pair with no organization match at all — impossible here,
 * since the blocking key IS the organization match). Revisit this constant if `NAME_LEVELS`/`CODE_SET_LEVELS`
 * (`registry/resolve.ts`) or `buildDefaultModel`'s `lambda` change, or once EM/real filer data can calibrate it
 * properly (seed, not a universal constant — same caveat the library's own `ComparisonLevel`s carry).
 */
export const INFERRED_LINK_THRESHOLD = -13

/**
 * Rows per `INSERT` statement when bulk-writing `filer_cluster` — keeps well under SQLite's bound parameter limit (3
 * columns/row) without needing a staging-table apparatus; this module reads the whole graph into memory for union-find
 * regardless, so there's no streaming/batch-commit concern the way `build-filer.ts` has.
 */
const CLUSTER_INSERT_BATCH_SIZE = 500

/**
 * The result of {@linkcode clusterAuthoritativeComponents}.
 */
export interface AuthoritativeClusterResult {
	/**
	 * Connected components found (singletons included — every `filer_node` row lands in exactly one).
	 */
	clusters: number
	/**
	 * Total `filer_node` rows assigned a cluster (== `filer_cluster` rows written with `assertion: "authoritative"`).
	 */
	nodes: number
}

/**
 * The result of {@linkcode clusterInferredLinks}.
 */
export interface InferredClusterResult {
	/**
	 * `form499_id` nodes carrying a `legal_name` attribute that canonicalized to a non-empty organization — the candidate
	 * universe pass (b) actually scored (see the module docstring's scope note for who's excluded).
	 */
	recordsConsidered: number
	/**
	 * Entities `resolveEntities` produced with MORE than one record — an inferred link was actually found (as opposed to
	 * a singleton, which contributes no edge).
	 */
	linkedClusters: number
	/**
	 * `filer_edge` rows written with `assertion: "inferred"` (one per non-representative member of a linked cluster).
	 */
	links: number
}

/**
 * Options shared by {@linkcode clusterInferredLinks} and {@linkcode clusterFilers}.
 */
export interface ClusterFilersOptions {
	/**
	 * Provenance vintage for every inferred `filer_edge` row this run writes — becomes both `source_vintage` and
	 * `valid_from` (decision 7: `valid_from` is mandatory; the inferred pass carries no finer-grained per-pair date than
	 * "when this clustering run happened").
	 */
	sourceVintage: string
	onProgress?: (message: string) => void
}

/**
 * The combined result of {@linkcode clusterFilers}.
 */
export interface ClusterFilersResult {
	authoritative: AuthoritativeClusterResult
	inferred: InferredClusterResult
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = []

	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size))
	}

	return chunks
}

/**
 * Deduplicate + sort, then whitespace-join — the "code-set string" shape {@linkcode ClusterFilersOptions}'s callers (and
 * `resolveEntities`'s `exactDiscriminators`) expect. Returns `""` for an empty input, which the caller treats as "no
 * attribute" (never a false `"different"` signal — see {@linkcode buildInferredRecords}).
 */
function codeSetString(values: Iterable<string>): string {
	return [...new Set(values)].toSorted().join(" ")
}

/**
 * Read every `filer_node` row, keyed by `node_id`. Shared by both {@linkcode readAuthoritativeGroups}'s callers (via
 * the group members) and {@linkcode buildInferredRecords} (to classify a group's members by identifier type).
 */
async function readNodeInfo(
	db: Kysely<FilerDatabase>
): Promise<Map<string, { identifierType: string; identifierValue: string }>> {
	const rows = await db
		.selectFrom("filer_node")
		.select(["node_id", "identifier_type", "identifier_value"])
		.orderBy("node_id")
		.execute()

	return new Map(
		rows.map((row) => [row.node_id, { identifierType: row.identifier_type, identifierValue: row.identifier_value }])
	)
}

/**
 * Recompute the authoritative connected components: every `filer_node` row (ordered by `node_id`, for a deterministic
 * result independent of SQLite's own row order), union-found over every `assertion: "authoritative"` `filer_edge`
 * (weight `Infinity` — an authoritative edge is never in doubt). A node touched by no authoritative edge is its own
 * singleton component (`cluster()`'s own contract — see `match/clustering.ts`).
 *
 * Recomputed from the edges each call (not read back from `filer_cluster`) so {@linkcode clusterInferredLinks} has no
 * write-order dependency on {@linkcode clusterAuthoritativeComponents} having run first — see the module docstring's
 * gate-2 section.
 */
async function readAuthoritativeGroups(db: Kysely<FilerDatabase>): Promise<string[][]> {
	const nodeRows = await db.selectFrom("filer_node").select(["node_id"]).orderBy("node_id").execute()
	const nodeIds = nodeRows.map((row) => row.node_id)

	const edgeRows = await db
		.selectFrom("filer_edge")
		.select(["from_node_id", "to_node_id"])
		.where("assertion", "=", FilerEdgeAssertion.Authoritative)
		.execute()

	const links: ScoredLink<string>[] = edgeRows.map((row) => ({
		a: row.from_node_id,
		b: row.to_node_id,
		weight: Number.POSITIVE_INFINITY,
	}))

	// threshold is irrelevant in value (every real link is Infinity) — 0 is as good as any finite number.
	return cluster(nodeIds, links, { threshold: 0 })
}

/**
 * Pass (a): cluster the authoritative edge graph into connected components and write `filer_cluster` rows with
 * `assertion: "authoritative"`. Idempotent (see the module docstring): clears every row carrying that assertion, then
 * writes the freshly computed set, inside one transaction.
 */
export async function clusterAuthoritativeComponents(db: Kysely<FilerDatabase>): Promise<AuthoritativeClusterResult> {
	const groups = await readAuthoritativeGroups(db)

	const rows: FilerClusterTable[] = groups.flatMap((group) => {
		// Content-derived, not index-derived — stable across reruns regardless of `cluster()`'s internal iteration
		// order (see the module docstring's idempotency section).
		const clusterId = `${FilerEdgeAssertion.Authoritative}:${[...group].toSorted()[0]}`

		return group.map((nodeId) => ({
			node_id: nodeId,
			cluster_id: clusterId,
			assertion: FilerEdgeAssertion.Authoritative,
		}))
	})

	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("filer_cluster").where("assertion", "=", FilerEdgeAssertion.Authoritative).execute()

		for (const batch of chunk(rows, CLUSTER_INSERT_BATCH_SIZE)) {
			if (batch.length) {
				await trx.insertInto("filer_cluster").values(batch).execute()
			}
		}
	})

	return { clusters: groups.length, nodes: rows.length }
}

/**
 * Read every `filer_attribute` row keyed `legal_name`, keeping — per `node_id` — the value from the LATEST
 * `source_vintage` (string comparison; filer.db's vintages are the sortable `YYYY-Qn`/ISO-date strings Task 5 writes).
 * A `form499_id` node re-filing under a new legal name over time is real (a rename, a DBA change); this module scores
 * the CURRENT name, not an arbitrary historical one.
 */
async function readLatestLegalNames(db: Kysely<FilerDatabase>): Promise<Map<string, string>> {
	const rows = await db
		.selectFrom("filer_attribute")
		.select(["node_id", "value", "source_vintage"])
		.where("key", "=", LEGAL_NAME_ATTRIBUTE_KEY)
		.execute()

	const latest = new Map<string, { value: string; vintage: string }>()

	for (const row of rows) {
		const current = latest.get(row.node_id)

		if (!current || row.source_vintage > current.vintage) {
			latest.set(row.node_id, { value: row.value, vintage: row.source_vintage })
		}
	}

	return new Map([...latest].map(([nodeId, { value }]) => [nodeId, value]))
}

/**
 * Build one {@link SourceRecord} per `form499_id` node with a (non-empty-after-canonicalization) legal name — the
 * candidate universe for pass (b). See the module docstring's scope note for who's excluded.
 */
async function buildInferredRecords(db: Kysely<FilerDatabase>): Promise<SourceRecord[]> {
	const nodeInfo = await readNodeInfo(db)
	const groups = await readAuthoritativeGroups(db)
	const legalNames = await readLatestLegalNames(db)

	const groupOfNode = new Map<string, string[]>()

	for (const group of groups) {
		for (const nodeId of group) {
			groupOfNode.set(nodeId, group)
		}
	}

	const codesByType = (group: string[], identifierType: string): string =>
		codeSetString(
			group
				.filter((nodeId) => nodeInfo.get(nodeId)?.identifierType === identifierType)
				.map((nodeId) => nodeInfo.get(nodeId)!.identifierValue)
		)

	const records: SourceRecord[] = []

	for (const [nodeId, info] of nodeInfo) {
		if (info.identifierType !== FilerIdentifierType.Form499ID) continue

		const legalName = legalNames.get(nodeId)

		if (!legalName) continue

		const organization = canonicalizeOrganizationName(legalName)

		if (!organization) continue

		const group = groupOfNode.get(nodeId) ?? [nodeId]

		const attributes: Record<string, string> = {}
		const frnCodes = codesByType(group, FilerIdentifierType.FRN)
		const form499Codes = codesByType(group, FilerIdentifierType.Form499ID)
		const providerCodes = codesByType(group, FilerIdentifierType.BDCProviderID)

		// Only set a key when there's an actual code to carry — an unset key reads as "missing" (no evidence) to
		// `resolveEntities`' exactDiscriminators comparison, never as a false "different" (see `registry/resolve.ts`'s
		// `similarityComparison`: a falsy extracted value short-circuits to "missing").
		if (frnCodes) {
			attributes.frn = frnCodes
		}

		if (form499Codes) {
			attributes.form499ID = form499Codes
		}

		if (providerCodes) {
			attributes.providerID = providerCodes
		}

		records.push({ id: nodeId, organization, attributes })
	}

	return records
}

/**
 * Pass (b): name-match `form499_id` nodes across the whole crosswalk via `resolveEntities` (decision 4: BINDING
 * `learnedScorer: false`), and record the outcome as `assertion: "inferred"` rows — WITHOUT touching any `assertion:
 * "authoritative"` row (decision 5 / gate 2, BINDING; see the module docstring).
 *
 * Writes, both idempotent (see the module docstring):
 *
 * - `filer_cluster` rows (`assertion: "inferred"`) for every record `resolveEntities` considered — singletons included,
 *   so every scored node gets an inferred assignment, mirroring pass (a)'s own completeness.
 * - `filer_edge` rows (`assertion: "inferred"`) for every entity with more than one member: one edge per
 *   non-representative member → the entity's `representative`, carrying `match_score` (the entity's `cohesion` — the
 *   WEAKEST intra-cluster link weight; `resolveEntities` doesn't expose the individual pairwise weights behind a larger
 *   entity, so this is the honest single number available) and `evidence` (the full membership, as JSON).
 */
export async function clusterInferredLinks(
	db: Kysely<FilerDatabase>,
	options: ClusterFilersOptions
): Promise<InferredClusterResult> {
	const progress = options.onProgress ?? (() => {})

	const records = await buildInferredRecords(db)

	progress(`pass (b): scoring ${records.length.toLocaleString()} form499_id record(s) with a legal name`)

	const { entities } = resolveEntities(records, {
		// The library's default blocking keys are geo/address/phone/email (`defaultBlockingKeys`,
		// `registry/resolve.ts`) — filer.db carries none of those (decision 2: no coordinates until ASR, Phase 3c), so
		// the default would propose zero candidate pairs. Block on the exact canonicalized organization name instead.
		blockingKeys: [exactKey((record: SourceRecord) => record.organization?.canonical)],
		exactDiscriminators: ["frn", "form499ID", "providerID"],
		// Decision 4, BINDING: the bundled GBT is trained on NPPES healthcare dedup; its calibrated threshold isn't in
		// Fellegi-Sunter weight units and has no business scoring corporate legal names.
		learnedScorer: false,
		threshold: INFERRED_LINK_THRESHOLD,
	})

	const clusterRows: FilerClusterTable[] = []
	let linkedClusters = 0
	let links = 0

	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("filer_cluster").where("assertion", "=", FilerEdgeAssertion.Inferred).execute()

		for (const entity of entities) {
			const memberNodeIds = entity.records.map((record) => record.id).toSorted()
			// Content-derived (see clusterAuthoritativeComponents) — stable across reruns.
			const clusterId = `${FilerEdgeAssertion.Inferred}:${memberNodeIds[0]}`

			for (const nodeId of memberNodeIds) {
				clusterRows.push({ node_id: nodeId, cluster_id: clusterId, assertion: FilerEdgeAssertion.Inferred })
			}

			if (entity.records.length <= 1) continue

			linkedClusters++
			const representativeId = entity.representative.id

			for (const nodeId of memberNodeIds) {
				if (nodeId === representativeId) continue

				await trx
					.insertInto("filer_edge")
					.values({
						from_node_id: nodeId,
						to_node_id: representativeId,
						assertion: FilerEdgeAssertion.Inferred,
						source: CLUSTER_FILERS_SOURCE,
						source_vintage: options.sourceVintage,
						valid_from: options.sourceVintage,
						valid_to: null,
						match_score: entity.cohesion,
						evidence: JSON.stringify({ memberNodeIds }),
					})
					// filer_edge's own composite PK (from, to, source, valid_from) already makes this idempotent —
					// unlike filer_cluster, it needs no clear-then-rewrite (see the module docstring).
					.onConflict((oc) => oc.doNothing())
					.execute()

				links++
			}
		}

		for (const batch of chunk(clusterRows, CLUSTER_INSERT_BATCH_SIZE)) {
			if (batch.length) {
				await trx.insertInto("filer_cluster").values(batch).execute()
			}
		}
	})

	progress(
		`pass (b): ${linkedClusters.toLocaleString()} inferred link(s) found, ${links.toLocaleString()} filer_edge row(s) written`
	)

	return { recordsConsidered: records.length, linkedClusters, links }
}

/**
 * Run both passes, in the documented order (convenience only — see the module docstring: pass (b) has no write-order
 * dependency on pass (a) having run first).
 */
export async function clusterFilers(
	db: Kysely<FilerDatabase>,
	options: ClusterFilersOptions
): Promise<ClusterFilersResult> {
	const authoritative = await clusterAuthoritativeComponents(db)
	const inferred = await clusterInferredLinks(db, options)

	return { authoritative, inferred }
}
