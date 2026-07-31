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
 *   target).
 *
 *   **Honest description of what pass (b) actually does (review fix, round 1):** blocking is on the
 *   EXACT canonicalized organization name, and the Fellegi-Sunter model's own organization comparison
 *   extracts that SAME field — so every candidate pair this module ever scores already has
 *   `similarity === 1.0` on that comparison, i.e. `NAME_LEVELS`' `"high"` (0.88) tier is dead code
 *   here; nothing below an exact canonical match ever reaches the scorer. Pass (b) is, in substance,
 *   `GROUP BY canonicalizeOrganizationName(legal_name)` **plus a hard identifier veto** — NOT
 *   approximate/fuzzy name linkage. (`@mailwoman/match`'s default blocking keys are geo/address/
 *   phone/email — filer.db carries none of those until ASR lands in Phase 3c, decision 2 — so the
 *   library defaults would propose zero candidate pairs; that's why blocking is overridden at all.)
 *
 *   **The identifier veto (review fix, round 1, CRITICAL — decision 5's real enforcement
 *   mechanism):** an adversarial review found that two DIFFERENT authoritative components ALWAYS have
 *   fully disjoint `frn`/`form499ID`/`providerID` code sets (structurally — a shared code would mean
 *   a shared node, which means union-find would already have merged those components in pass (a)). So
 *   `exactDiscriminators` could only ever contribute their "different" level for a genuine
 *   cross-component candidate — a CONSTANT negative tax that `INFERRED_LINK_THRESHOLD` exists to
 *   cancel, never an actual separator. Net effect: FEWER identifiers present on a pair scored HIGHER
 *   (fewer negative contributions) — the exact inverse of what a discriminator should do, and it
 *   produced real false-identity links in review (two unrelated companies sharing a common corporate
 *   name pattern, e.g. "American Broadband LLC" / "American Broadband, Inc." with disjoint FRNs).
 *   Merging two unrelated registrants is the worst output this crosswalk can produce, even tagged
 *   `"inferred"`.
 *
 *   The fix is NOT a threshold retune — {@linkcode hasSharedIdentifier} is a HARD pre-filter wired in
 *   as `resolveEntities`'s custom `scorer` ({@linkcode scoreWithIdentifierVeto}): two records with NO
 *   shared code across ALL THREE identifier types are vetoed to `-Infinity`, unconditionally, before
 *   the name score is even consulted — no name similarity, however exact, can outvote it. A link can
 *   only ever form when the two nodes ALREADY share an authoritative identifier (in practice: two
 *   `form499_id` nodes in the SAME authoritative component, e.g. a re-filing under one FRN with a
 *   drifted legal name) — this repurposes what were previously three inert, always-negative
 *   comparisons into the thing that actually makes a link SAFE. "Two different FRNs" is treated as
 *   authoritative ground truth in this domain: full stop, no name match overrides it.
 *
 *   **Degenerate discovery scope — ACCEPTED for 3a, a coordinator decision, not a defect (review fix,
 *   round 2).** Because `attributes.frn`/`.form499ID`/`.providerID` are derived PER AUTHORITATIVE
 *   COMPONENT (every member of one component carries the identical code-set strings — see the field
 *   list above), {@linkcode hasSharedIdentifier} finding ANY overlap is now, by construction, EXACTLY
 *   equivalent to "these two nodes are already in the same authoritative component." Consequently, pass
 *   (b) as it stands CANNOT discover a link between two nodes that pass (a) doesn't already connect —
 *   it can only ever CONFIRM/re-surface an existing authoritative grouping via name matching, never
 *   bridge two genuinely separate ones. This is intentional, not a bug to chase: a linker that discovers
 *   nothing is safe; a linker that discovers FALSE links (the CRITICAL bug the identifier veto fixes,
 *   above) is not — and 3a's decision 5 scope was authoritative-only anyway. Restoring genuine
 *   cross-component discovery power requires corroborating evidence BEYOND the canonical name (e.g. a
 *   normalized HQ address, a contact phone/email) — that data doesn't exist reliably in this crosswalk
 *   until CORES and EDGAR land in Phase 3b, so it's explicitly deferred there, not attempted here.
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
 *   `assertion` value, then INSERT the freshly computed set. Re-running either pass AT THE SAME
 *   `sourceVintage` against unchanged input data reproduces byte-identical `(node_id, cluster_id)`
 *   rows (cluster ids are CONTENT-DERIVED — `` `${assertion}:${lexicographically-smallest member
 *   node_id}` `` — not index-based, so they don't depend on iteration order surviving between runs).
 *
 *   **Cross-vintage supersession (review fix, round 1; round-2 fix for the SAME-vintage residual — the
 *   same-vintage idempotency claim above does NOT, by itself, extend to a REBUILD at that same
 *   vintage).** `filer_edge`'s composite PK plus `INSERT ... ON CONFLICT DO NOTHING` only makes an
 *   UNCHANGED same-vintage rerun idempotent; it does nothing for a rerun (same OR later vintage) whose
 *   underlying data changed. A prior review incorrectly claimed this table "doesn't need anything
 *   extra" — in fact, rerunning at vintage v2 after names diverged left `filer_cluster` correctly split
 *   back into singletons while the STALE v1 inferred edge survived with `valid_to: null` ("still
 *   valid"), directly contradicting the current `filer_cluster` snapshot. A follow-up review then found
 *   the SAME bug class, narrowed: a REBUILD at the SAME `sourceVintage` (e.g. filer.db corrected and
 *   rebuilt without bumping the clustering vintage label) hit the identical contradiction, because the
 *   round-1 fix's `valid_from < sourceVintage` comparison was strict and never touched a row already AT
 *   that vintage.
 *
 *   Fixed with TWO separate operations, at the START of every {@linkcode clusterInferredLinks} call,
 *   before writing the freshly computed set — chosen deliberately over a single inclusive (`<=`)
 *   comparison, which would have closed a row to `valid_to === valid_from` (a zero-duration window) on
 *   an UNCHANGED same-vintage rerun and then had `ON CONFLICT DO NOTHING` refuse to re-open it,
 *   permanently mislabeling a still-valid link "closed":
 *
 *   1. **DELETE** every inferred `filer_edge` row AT this run's OWN `sourceVintage` (`valid_from =
 *      sourceVintage`). A same-vintage rebuild has no meaningful "historical" state to preserve at a
 *      vintage that, by definition, hasn't changed identity — full replace, mirroring `filer_cluster`'s
 *      own clear-and-rewrite discipline for this same pass.
 *   2. **CLOSE** (`SET valid_to = sourceVintage`) every still-open (`valid_to IS NULL`) inferred edge
 *      from a STRICTLY EARLIER vintage (`valid_from < sourceVintage`). This is genuine history
 *      (decision 7's provenance-plurality) — a link asserted at an earlier vintage that no longer holds
 *      becomes a closed row, not an erased one, and a link that DOES persist gets a new, separate row
 *      at the new vintage rather than an update-in-place.
 *
 *   **Scope note:** only `form499_id` nodes carry a `legal_name` attribute (Task 5's builder never
 *   attaches attributes to `frn` / `bdc_provider_id` / holding- or management-company nodes), so
 *   those are the only nodes pass (b) can name-match. A provider that only ever appears in the BDC
 *   provider list (no corresponding Form 499 filing) has no legal name in this crosswalk and is
 *   invisible to the inferred pass — a real, documented gap, not an oversight.
 */

import { cluster, exactKey, scorePair, type ScoredLink } from "@mailwoman/match"
import { canonicalizeOrganizationName } from "@mailwoman/record"
import { buildDefaultModel, resolveEntities, type SourceRecord } from "@mailwoman/registry"
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
 * The `SourceRecord.attributes` keys {@linkcode hasSharedIdentifier} checks — the same three passed as
 * `exactDiscriminators` to `resolveEntities`.
 */
const IDENTIFIER_VETO_KEYS = ["frn", "form499ID", "providerID"] as const

/**
 * HARD VETO (review fix, round 1 — decision 5's real enforcement mechanism; see the module docstring's "identifier
 * veto" section). `true` when `a` and `b` share at least one code across ANY of {@link IDENTIFIER_VETO_KEYS}. In this
 * domain, identifiers are authoritative — two different FRNs mean two different registrants, full stop, no matter how
 * similar the names look.
 *
 * A value missing on EITHER side is not evidence of "different" — it's silence on that dimension, so it never
 * contributes to the veto (only a value present AND disjoint on BOTH sides counts, exactly like `resolveEntities`'s own
 * `similarityComparison` treats a missing value as "no evidence", not "different"). Returns `false` — no shared
 * identifier, i.e. veto territory — when `a`/`b` have no identifier in common on any of the three types (including when
 * one or both sides carry no identifier data at all).
 */
export function hasSharedIdentifier(a: SourceRecord, b: SourceRecord): boolean {
	for (const key of IDENTIFIER_VETO_KEYS) {
		const valueA = a.attributes?.[key]
		const valueB = b.attributes?.[key]

		if (!valueA || !valueB) continue

		const codesA = new Set(valueA.split(" "))

		for (const code of valueB.split(" ")) {
			if (code && codesA.has(code)) return true
		}
	}

	return false
}

/**
 * The Fellegi-Sunter model used ONLY inside {@linkcode scoreWithIdentifierVeto} — built once, at module load, since it
 * depends on nothing but a fixed comparison config (no per-call state). `collapseSpatial: true` matches
 * `resolveEntities`'s own default; the choice is moot in practice, since no `SourceRecord` this module builds ever
 * populates `.address` (see the module docstring's "honest description" section), so the spatial comparison always
 * evaluates to "missing" regardless.
 */
const INFERRED_SCORING_MODEL = buildDefaultModel({
	collapseSpatial: true,
	exactDiscriminators: [...IDENTIFIER_VETO_KEYS],
})

/**
 * The custom `scorer` passed to `resolveEntities` (review fix, round 1) — this is where the hard identifier veto is
 * actually enforced. Supplying a `scorer` makes `resolveEntities` use THIS function's return value as a candidate
 * pair's match weight instead of its own internal `scorePair` call (`registry/resolve.ts`), so a disjoint-identifier
 * pair is forced to `-Infinity` — unable to clear ANY threshold — before the name-similarity score is even computed.
 * Only when {@linkcode hasSharedIdentifier} finds real overlap does the ordinary Fellegi-Sunter weight (over
 * {@link INFERRED_SCORING_MODEL}) decide the outcome.
 */
function scoreWithIdentifierVeto(a: SourceRecord, b: SourceRecord): number {
	if (!hasSharedIdentifier(a, b)) return Number.NEGATIVE_INFINITY

	return scorePair(INFERRED_SCORING_MODEL, a, b).weight
}

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
 * `source_vintage`. A `form499_id` node re-filing under a new legal name over time is real (a rename, a DBA change);
 * this module scores the CURRENT name, not an arbitrary historical one.
 *
 * **Constraint (documented, not enforced — review fix, round 1, minor):** "latest" is a plain STRING comparison (`>`),
 * not a date parse. This is safe in practice because `legal_name` is exclusively `form-499`-sourced (Task 5's builder
 * never attaches it from `bdc-provider-list`), and `source_vintage` for every `form-499` row is the row's own
 * `lastFiledAt` — a real filing-date string, not a synthetic label like `bdc-provider-list` edges' `"2026-Q1"`. As long
 * as every `legal_name` vintage for one node is drawn from that SAME lexicographically-sortable date scheme (the
 * assumption this whole module makes about `filer.db`), `>` and "chronologically later" agree. This breaks if that
 * assumption is ever violated (e.g. a future source starts writing `legal_name` with a differently formatted or
 * non-chronological `source_vintage`) — at that point "latest" here means "lexicographically greatest", silently, not
 * "chronologically latest".
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

		// `canonicalizeOrganizationName` returns a TRUTHY object even when the whole input was designation
		// tokens (e.g. a bare "LLC") and stripped down to an EMPTY canonical string — `!organization` alone
		// misses that case (review fix, round 1, minor), inflating `recordsConsidered` with a record that
		// can never usefully block (an empty-string blocking key never matches another record; see
		// `exactKey`, `match/blocking.ts`).
		if (!organization || !organization.canonical) continue

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
 * `learnedScorer: false`; review fix round 1: a HARD identifier veto via a custom `scorer`, see
 * {@linkcode scoreWithIdentifierVeto} and the module docstring's "identifier veto" section), and record the outcome as
 * `assertion: "inferred"` rows — WITHOUT touching any `assertion: "authoritative"` row (decision 5 / gate 2, BINDING;
 * see the module docstring).
 *
 * Writes:
 *
 * - `filer_cluster` rows (`assertion: "inferred"`) for every record `resolveEntities` considered — singletons included,
 *   so every scored node gets an inferred assignment, mirroring pass (a)'s own completeness. Idempotent the same way as
 *   pass (a) (see the module docstring): cleared and rewritten wholesale, every run.
 * - `filer_edge` rows (`assertion: "inferred"`) for every entity with more than one member: one edge per
 *   non-representative member → the entity's `representative`, carrying `match_score` (the entity's `cohesion` — the
 *   WEAKEST intra-cluster link weight; `resolveEntities` doesn't expose the individual pairwise weights behind a larger
 *   entity, so this is the honest single number available) and `evidence` (the full membership, as JSON). Made
 *   idempotent/current EVERY run, same-vintage or not, by clearing this run's own vintage first and closing out any
 *   still-open EARLIER-vintage row (review fix, rounds 1 + 2 — see the module docstring's "cross-vintage supersession"
 *   section) so a link that no longer holds never lingers as falsely "still valid".
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
		// Wired through for documentation/config parity (and in case `requireCorroboration`/`trainEM` are ever
		// enabled here) — but note the ACTUAL weight for every pair comes from `scorer` below, not from
		// resolveEntities' own internal model built from this config (see scoreWithIdentifierVeto's docstring).
		exactDiscriminators: [...IDENTIFIER_VETO_KEYS],
		// Decision 4, BINDING: the bundled GBT is trained on NPPES healthcare dedup; its calibrated threshold isn't in
		// Fellegi-Sunter weight units and has no business scoring corporate legal names. Redundant with `scorer` below
		// (a custom `scorer` already bypasses the learned-scorer branch entirely) but kept explicit for intent.
		learnedScorer: false,
		// Review fix, round 1, CRITICAL: the hard identifier veto — see the module docstring and
		// scoreWithIdentifierVeto's own docstring. Two records with no shared frn/form499ID/providerID code are
		// forced to -Infinity here, unconditionally, before name similarity is ever consulted.
		scorer: scoreWithIdentifierVeto,
		threshold: INFERRED_LINK_THRESHOLD,
	})

	const clusterRows: FilerClusterTable[] = []
	let linkedClusters = 0
	let links = 0

	await db.transaction().execute(async (trx) => {
		// Cross-vintage supersession (review fix, round 1; round-2 fix for the SAME-vintage residual — see the
		// module docstring). Two cases, handled separately because they mean different things:
		//
		// 1. SAME-vintage rebuild (`valid_from = sourceVintage`) — DELETE, not close. This run's own prior
		//    output at this exact vintage is being fully superseded (e.g. filer.db was rebuilt with corrected
		//    input under the same clustering vintage label) — there is no meaningful "historical" state to
		//    preserve at a vintage that, by definition, hasn't changed identity, and closing a row to its OWN
		//    valid_from (a zero-duration `valid_from == valid_to` window) would itself be a stale, un-reassertable
		//    row: `INSERT ... ON CONFLICT DO NOTHING` below would silently skip re-inserting a still-valid link at
		//    that same PK, permanently mislabeling it "closed". Deleting first, then letting the loop below
		//    reinsert whatever the CURRENT data actually supports, is the only rebuild-safe option — mirrors
		//    filer_cluster's own clear-and-rewrite discipline for this same pass.
		// 2. EARLIER-vintage edges (`valid_from < sourceVintage`) — CLOSE (`SET valid_to`), not delete. These are
		//    genuine history (decision 7's provenance-plurality): a link asserted at an earlier vintage that no
		//    longer holds becomes a closed row, not an erased one.
		await trx
			.deleteFrom("filer_edge")
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.where("source", "=", CLUSTER_FILERS_SOURCE)
			.where("valid_from", "=", options.sourceVintage)
			.execute()

		await trx
			.updateTable("filer_edge")
			.set({ valid_to: options.sourceVintage })
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.where("source", "=", CLUSTER_FILERS_SOURCE)
			.where("valid_to", "is", null)
			.where("valid_from", "<", options.sourceVintage)
			.execute()

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
					// Both the same-vintage-rebuild and earlier-vintage-supersession cases are handled ABOVE, before
					// this loop runs (see the module docstring's "cross-vintage supersession" section) — this
					// `onConflict` is now just a defensive no-op for the (already-cleared) same-vintage PK.
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
