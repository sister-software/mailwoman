/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `filerLookup` — the identity-crosswalk reader, and the module the four pre-registered 3a
 *   acceptance gates live against (`describe("§7-3a gates")` in `filer-lookup.test.ts`; see
 *   `docs/superpowers/plans/2026-07-31-filer-3a-plan.md`'s "Acceptance gates (§7-3a…)" section for the
 *   gates verbatim). One identifier in — `frn` XOR `form499ID` XOR `bdcProviderID`, matching
 *   `filingLandscape`'s XOR discipline (`bdc/sdk/filing-landscape.ts`) — one crosswalk view out: every
 *   OTHER identifier this node shares an AUTHORITATIVE, SAME-ENTITY edge with (see below), its flattened current
 *   attributes, its authoritative cluster (never touched by an inferred
 *   edge — decision 5 / gate 2), and its inferred links reported SEPARATELY with their score/source.
 *   Every relationship in the answer is scoped `asOf` a date (default: today), and `as_of` is always
 *   present in the result so a caller never has to guess which view they got.
 *
 *   **`identifiers` is `relationship: same_entity` ONLY.** Built from EVERY authoritative edge regardless of
 *   `relationship`, it would surface a `HoldingCompany`/`ManagementCompany` edge — correctly typed
 *   authoritative by the builder — as if the holding-company NAME were "this filer's own identifier":
 *   exactly the entity/family conflation gate 1 exists to prevent, hiding in a different field than
 *   `cluster`. So `identifiers` answers ONLY "which other identifiers denote this SAME legal entity";
 *   a holding-/management-company relationship is reported via `families` instead, which carries the raw
 *   company name(s) in its own `display_names` field rather than in `identifiers`.
 *
 *   **Manifest-first (gate 4's "always stamped" half).** `readFilerManifest` runs before any node/edge
 *   query — a missing/broken manifest throws immediately (matching `filingLandscape`'s own ordering)
 *   rather than this reader ever answering with a made-up or missing `vintage`. Immediately after,
 *   {@linkcode assertFamilySchemaVersion} refuses an artifact whose `schema_version` predates
 *   `filer_family` with a descriptive, rebuild-pointing error — not a
 *   raw "no such table: filer_family" surfaced straight from SQLite once this reader started
 *   unconditionally querying that table.
 *
 *   **Temporal scoping (gate 4).** An edge is "in force" `asOf` a date when `valid_from <= asOf AND
 *   (valid_to IS NULL OR asOf < valid_to)` — the same half-open-interval convention `cluster-filers.ts`'s
 *   cross-vintage supersession already commits to (`valid_to` marks the date an assertion STOPPED
 *   holding, not the last date it held). Applied identically to `identifiers` and `inferred_links`.
 *
 *   **Authoritative/inferred never conflated (gate 2).** `cluster` is read from `filer_cluster WHERE
 *   assertion = 'authoritative'` ONLY; `inferred_links` is read from `filer_edge WHERE assertion =
 *   'inferred'` ONLY — two disjoint queries against two disjoint slices. There is no code path here that
 *   could fold an inferred relationship into the authoritative `cluster` field: the same guarantee
 *   `cluster-filers.ts` makes on the write side (decision 5), restated here on the read side.
 *
 *   **Gate 2 reaches `families` too.** Those two disjoint queries are both
 *   `filer_edge`-backed, so until `filer_family` grew its own `assertion`/`match_score` the gate stopped
 *   at the table boundary — and `families`/`familyRollup` answer from `filer_family` ALONE (that is the
 *   whole precondition). The EDGAR ingest writes the repo's first INFERRED family membership,
 *   which therefore arrived here shape-identical to a Form 499 holding-company disclosure the filer
 *   itself filed. {@link FilerLookupFamily} now carries the grading, and a same-family authoritative row
 *   and inferred row are reported as two entries, never folded into one.
 *
 *   **`cluster` is `asOf`-scoped too.** `filer_cluster` itself carries no
 *   temporal columns (`schema.ts`) — `cluster-filers.ts`'s `clusterAuthoritativeComponents` recomputes it
 *   from whatever the CURRENT edge graph looks like on every run, with no `asOf` concept of its own. Read
 *   unguarded, that snapshot would let `cluster` assert full present-day membership at ANY `asOf` date,
 *   directly contradicting `identifiers`'s own scoping (reviewer probe: `asOf` before any connecting edge
 *   existed returned `identifiers: []` yet `cluster` still asserted two nodes were one entity — the same
 *   self-contradiction the primary-FRN temporal fix, above, closed for that probe). {@linkcode
 *   deriveClusterMembersAsOf} closes this: the static snapshot's member list is filtered down to whatever
 *   an authoritative edge, in force `asOf` the query date, actually corroborates. A node whose static
 *   cluster membership has no such corroborating edge reports `cluster: null` for that `asOf`, not the
 *   full snapshot — see {@link FilerLookupCluster}'s own docstring.
 *
 *   **Primary-FRN rule (gate 3, decision 6).** A `bdc_provider_id` node can carry more than one
 *   authoritative FRN edge (one `provider_id` can appear on multiple provider-list rows under
 *   different FRNs) — `identifiers` reports ALL of them, never collapsed. When more than one FRN
 *   identifier is found, {@linkcode readFRNFilingCandidates} reads each FRN's own most recent
 *   `form-499` filing edge (same half-open temporal scoping as everywhere else in this reader — see
 *   below) and {@linkcode pickPrimaryFRN} — decision 6's documented rule, "the primary FRN is the one
 *   from the most recent 499 filing date" — picks the winner. Both are pure and exported because
 *   `bdc/sdk/build-bdc.ts`'s `bdc_provider` population needs the same answer: `ProviderListRow` carries
 *   no `filedAt` of its own, so that caller has to assemble `{frn, filedAt}` candidates by querying
 *   `filer.db`'s own `form-499` edges. Reusing {@linkcode readFRNFilingCandidates} rather than
 *   reimplementing that query keeps the rule AND its candidate assembly each in exactly one home,
 *   temporal scoping included.
 *
 *   **A derived conclusion is never indistinguishable from a sourced fact.** The picked primary FRN is
 *   reported in its OWN top-level `primary_frn` field, never
 *   folded into `attributes` — `attributes` is exclusively flattened `filer_attribute` ROWS (real
 *   provenance: `source`/`source_vintage` on every fact), and a computed value written there under the
 *   same key as a genuine sourced attribute would silently clobber it (reviewer-confirmed) and, even
 *   without a collision, be visually indistinguishable from one. `primary_frn` carries `derived_from`
 *   and `as_of` instead of `source`/`source_vintage` — its provenance is "this reader's own
 *   computation", not a row in `filer.db`, and that must stay legible at the call site.
 *
 *   **`families` is a separate rollup from `cluster` (§7-3b gate 1, load-bearing).** `cluster` answers
 *   "which OTHER identifiers denote this SAME filer" (entity resolution); `families` answers "which
 *   corporate family (holding/management tree) does this filer belong to" — spec §4.1 keeps these two
 *   rollups apart on purpose, because folding them together is exactly the error that makes a broadband
 *   competition count misleading (two identifiers for one ISP look the same, on paper, as ten subsidiaries
 *   of one holding company, unless the rollups stay distinct). `families` is read from `filer_family`
 *   ONLY, via its own query that never touches `filer_cluster`/`filer_edge`'s authoritative-cluster path
 *   above — the identical "two disjoint queries, never a shared code path" discipline gate 2 (3a) already
 *   established for `cluster` vs `inferred_links`. Scoped `asOf` with the SAME half-open predicate as every
 *   other temporal read in this module (`filer/sdk/family-rollup.ts` copies this exact predicate rather
 *   than writing its own — independently written copies of it have drifted apart before).
 *
 *   **`family_id` alone is a canonicalized slug, not a display name.** Each
 *   {@link FilerLookupFamily} entry also carries {@linkcode readFamilyDisplayNames}'s output — the family's
 *   raw holding-/management-company name spelling(s), recovered from the `filer_edge` rows that imply the
 *   membership. See that function's docstring for why a MULTI-spelling family (two raw names that
 *   canonicalize identically) surfaces every spelling rather than picking one.
 *
 *   **This reader canonicalizes NOTHING.** `filer.db` is a sealed, shipped artifact
 *   with its own version line; `@mailwoman/record`'s `canonicalizeOrganizationName` lives in another
 *   workspace and its designation/jurisdiction packs are explicitly documented as extensible. So no fact
 *   behind `families`/`display_names` is re-derived here — each is READ from a column the builder wrote,
 *   the naming provenance included: that is what `filer_family.naming_node_id` is for. (Not a claim that
 *   this reader derives nothing at all: `primary_frn` is
 *   openly this reader's own computation, labelled as such at its own docstring below. The distinction is
 *   that a DERIVED conclusion is declared as one, while a re-derived canonical KEY silently disagrees with
 *   the artifact that stored it.) `mintFamilyID` (`family-id.ts`) remains the WRITER'S single derivation
 *   rule and is still exported for callers that need to mint a `family_id` to query BY; nothing in the
 *   read path calls it.
 */

import type { DatabaseClient } from "@mailwoman/core/kysley/client"

import {
	FILER_FAMILY_SCHEMA_VERSION,
	FilerEdgeAssertion,
	FilerIdentifierType,
	FilerRelationship,
	readFilerManifest,
	type FilerDatabase,
	type FilerNodeTable,
} from "../schema.ts"
import { isFRN, type FRN } from "./frn.ts"

/**
 * Exactly one of `frn`/`form499ID`/`bdcProviderID` is required — {@linkcode filerLookup} throws otherwise (matching
 * `filingLandscape`'s XOR discipline). `asOf` defaults to today (see {@linkcode filerLookup}); every temporal
 * comparison in the result — `identifiers`, `inferred_links` — is scoped to it.
 */
export interface FilerLookupQuery {
	frn?: FRN
	form499ID?: string
	bdcProviderID?: number
	asOf?: string
}

/**
 * One OTHER identifier the queried node shares an AUTHORITATIVE, SAME-ENTITY edge with, `asOf` the query's date (see
 * the module docstring's "identifiers is relationship: same_entity ONLY" section). `type` is one of
 * {@link FilerIdentifierType}. A holding-/management-company relationship never appears here — that fact belongs to
 * {@link FilerLookupResult.families} instead.
 */
export interface FilerLookupIdentifier {
	type: string
	value: string
	source: string
	source_vintage: string
}

/**
 * The queried node's AUTHORITATIVE cluster (gate 2), `asOf`-scoped (see {@linkcode deriveClusterMembersAsOf}) — `null`
 * when clustering (`cluster-filers.ts`) has never been run, the node carries no authoritative cluster assignment, or
 * (the asOf-scoping case) no authoritative edge corroborating the assignment is in force as of the query's `asOf` date.
 * `members` are `filer_node.node_id`s, and may be a PROPER SUBSET of the full `filer_cluster` snapshot's membership
 * when the component only partially held together as of that date.
 */
export interface FilerLookupCluster {
	cluster_id: string
	members: string[]
}

/**
 * One INFERRED relationship the queried node carries, `asOf` the query's date — reported SEPARATELY from
 * {@link FilerLookupResult.cluster} (gate 2), never merged into it. `to` is the other end's `filer_node.node_id`.
 */
export interface FilerLookupInferredLink {
	to: string
	score: number | null
	source: string
}

/**
 * One corporate-family membership the queried node carries, `asOf` the query's date — reported on
 * {@link FilerLookupResult.families}, a field STRUCTURALLY DISTINCT from {@link FilerLookupResult.cluster} (§7-3b gate
 * 1, load-bearing). `relationship` is one of {@link FilerRelationship} (`holding_company`, `management_company`,
 * `parent_company`, `subsidiary` — never `same_entity`, which is reserved for entity-cluster edges and never written to
 * `filer_family`). Deliberately carries NO `members` field and NO `cluster_id`-shaped key — see the module docstring's
 * "families is a separate rollup" section for why that shape difference is the whole point: a family membership must
 * never be confusable with, or foldable into, an entity-cluster member. Use {@linkcode familyRollup}
 * (`family-rollup.ts`) to read a family's FULL membership list; this field only answers "which families does THIS node
 * belong to, and under what relationship."
 *
 * `display_names` is the DISTINCT set of raw `identifier_value` spellings, across every current member of this family,
 * that imply the membership — the human-readable name(s) behind the canonicalized `family_id`, which the headline
 * "these filers report holding company H" output needs and the slug alone cannot supply. See
 * {@linkcode
 * readFamilyDisplayNames}'s docstring for the exact join and the "expose the plurality, never collapse" rule
 * this follows when two spellings (e.g. `"Realbuild Co"` / `"REALBUILD CO., INC."`) canonicalize to the SAME
 * `family_id`.
 */
export interface FilerLookupFamily {
	family_id: string
	relationship: string
	/**
	 * One of {@link FilerEdgeAssertion} — how strongly this membership is evidenced. `authoritative` is a membership the
	 * source document states directly (a Form 499 row naming its own holding company); `inferred` is one a matcher
	 * concluded (EDGAR's subsidiary-name→FRN corroboration). This field is what carries gate 2's "inferred never merges
	 * with authoritative" rule past `cluster`/`inferred_links` (both `filer_edge`-backed) onto the family surface:
	 * without it a name-match guess arrives here byte-identical to a filed disclosure and a caller has no way to tell
	 * them apart. `source` cannot stand in for it: `edgar-exhibit-21` produces BOTH grades.
	 */
	assertion: string
	/**
	 * The inferred match's score, `null` on an authoritative membership (`schema.ts`'s CHECK constraint enforces that
	 * direction) — the same "reported SEPARATELY with their score" treatment {@link FilerLookupInferredLink} gives an
	 * inferred edge, restated on the family surface.
	 */
	match_score: number | null
	display_names: string[]
}

export interface FilerLookupResult {
	node: FilerNodeTable
	identifiers: FilerLookupIdentifier[]
	/**
	 * Flattened `filer_attribute` facts for the queried node ONLY — one value per `key`, the LATEST `source_vintage`
	 * winning on a repeat key (same plain-string-comparison convention as `cluster-filers.ts`'s `readLatestLegalNames`;
	 * see that function's docstring for the "lexicographically greatest, not date-parsed" caveat). Every value here is a
	 * real `filer_attribute` row with its own `source`/`source_vintage` provenance — NEVER a computed value (see
	 * {@link FilerLookupResult.primary_frn} for the derived counterpart, kept structurally separate on purpose).
	 */
	attributes: Record<string, string>
	cluster: FilerLookupCluster | null
	inferred_links: FilerLookupInferredLink[]
	/**
	 * Every corporate-family membership the queried node carries, `asOf` the query's date (§7-3b gate 1, load-bearing) —
	 * read EXCLUSIVELY from `filer_family`, a query that never shares a code path with `cluster` above. A family
	 * membership can never appear here as a `cluster` entry, and a `cluster` member can never appear here unless
	 * `filer_family` independently asserts it — the two rollups are answers to different questions (same filer under
	 * another identifier, vs. same corporate family as a DIFFERENT filer) and this field's shape
	 * ({@link FilerLookupFamily}: `family_id`/`relationship`) is structurally incompatible with
	 * {@link FilerLookupCluster} (`cluster_id`/`members`) on purpose. Empty array, never `null`, when the node carries no
	 * family membership as of this date — `cluster`'s `null` means "no cluster has ever been computed for this node";
	 * there is no analogous "never computed" state for `families`, since every `filer_family` row is a direct fact, not a
	 * derived snapshot.
	 *
	 * **One entry per DISTINCT `(family_id, relationship, assertion, match_score)`, not one per `filer_family` row.** A
	 * single membership can be asserted by several rows — two sources reporting it, or two raw spellings that
	 * canonicalize to one `family_id` (`filer_family`'s PK carries `naming_node_id`, so those stay separate rows). The
	 * rule is that the dedup key is exactly the projected tuple: two rows this shape cannot tell apart would arrive as
	 * byte-identical entries, and a caller counting the array would read repetition as multiplicity. Two rows it CAN tell
	 * apart are two different claims a caller can act on — an authoritative membership and an inferred one for the same
	 * family are reported as two entries on purpose, which is the whole point of `assertion` being here. The plurality
	 * the shape still cannot express is not lost, only moved to the surfaces that can: every spelling appears in
	 * `display_names`, and per-member `source`/`valid_from` provenance is on `familyRollup`'s members
	 * (`family-rollup.ts`).
	 */
	families: FilerLookupFamily[]
	/**
	 * The primary-FRN pick (decision 6, gate 3) when the queried node carries more than one authoritative FRN identifier
	 * — `null` otherwise (including when cardinality is >1 but none of the FRNs has a form-499 filing to rank by). A
	 * DERIVED conclusion, never a sourced fact — see the module docstring's "A derived conclusion…" section for why this
	 * is its own field rather than an `attributes` entry.
	 */
	primary_frn: FilerLookupPrimaryFRN | null
	/**
	 * The date every temporal comparison in this result was scoped to — ALWAYS present, whether supplied by the caller or
	 * defaulted to today (gate 4).
	 */
	as_of: string
	/**
	 * `filer_manifest.source_vintage` — read (and validated) before any node/edge query (see the module docstring).
	 */
	vintage: string
}

/**
 * {@link FilerLookupResult.primary_frn}'s shape — visibly a DERIVED conclusion (`derived_from`, `as_of`), never
 * confusable with a sourced `filer_attribute` fact (which carries `source`/`source_vintage` instead).
 */
export interface FilerLookupPrimaryFRN {
	frn: FRN
	/**
	 * The rule that produced this pick — always {@link PRIMARY_FRN_DERIVATION} today, but a literal (rather than a
	 * boolean "isDerived" flag) so a future second derivation rule remains distinguishable from this one.
	 */
	derived_from: string
	/**
	 * The `asOf` date this pick was computed under — the SAME value as {@link FilerLookupResult.as_of}, repeated here so
	 * the field is self-describing if ever read in isolation from the rest of the result.
	 */
	as_of: string
}

/**
 * {@link FilerLookupPrimaryFRN.derived_from}'s value for {@linkcode pickPrimaryFRN}'s rule — decision 6, "the primary
 * FRN is the one from the most recent 499 filing date".
 */
export const PRIMARY_FRN_DERIVATION = "most-recent-499-filing"

/**
 * One FRN's own most recent `form-499` filing date — the input shape {@linkcode pickPrimaryFRN} consumes.
 */
export interface FRNFilingRecord {
	frn: FRN
	filedAt: string
}

/**
 * Decision 6's primary-FRN rule: given every FRN a `bdc_provider_id` carries (cardinality preserved in the graph — see
 * the module docstring's gate 3 section), picks the one with the most recent 499 filing date. "Most recent" is a plain
 * string comparison over `filedAt` (ISO-sortable filing dates), the same convention `cluster-filers.ts`'s
 * `readLatestLegalNames` uses for the identical reason. A tie keeps whichever candidate appears first in `candidates`
 * (deterministic, not meaningful — a genuine same-day double-filing under two different FRNs is not a case decision 6
 * resolves). Throws on an empty input: there is no "primary" of nothing.
 */
export function pickPrimaryFRN(candidates: readonly FRNFilingRecord[]): FRN {
	if (!candidates.length) {
		throw new Error("pickPrimaryFRN: at least one candidate is required — there is no primary FRN of nothing")
	}

	let latest = candidates[0]!

	for (const candidate of candidates) {
		if (candidate.filedAt > latest.filedAt) {
			latest = candidate
		}
	}

	return latest.frn
}

/**
 * Reads each `frn`'s own most recent `form-499` filing edge and returns the `{frn, filedAt}` candidates
 * {@linkcode pickPrimaryFRN} consumes — the query {@linkcode filerLookup} itself calls for gate 3's multi-FRN
 * `bdcProviderID` case, pulled out as its own exported function because `pickPrimaryFRN` alone isn't the whole reusable
 * unit: `ProviderListRow` carries no `filedAt` of its own, so `bdc/sdk/build-bdc.ts`'s `bdc_provider` population
 * (decision 6) MUST assemble candidates by querying `filer.db`'s own `form-499` edges, exactly like this. Reusing this
 * function instead of reimplementing the query keeps the temporal scoping below in one place.
 *
 * Applies the SAME full half-open predicate as every other temporal read in this module — `valid_from <= asOf AND
 * (valid_to IS NULL OR asOf < valid_to)` (see the module docstring; `schema.ts`'s `FilerEdgeTable.valid_to` documents
 * why the convention is half-open, not a stylistic choice). BOTH halves are load-bearing. With only `valid_from <=
 * asOf`, a CLOSED 499 edge (superseded by a later one, `valid_to` set to that later edge's `valid_from`) still wins the
 * "most recent" comparison over an in-force earlier edge, so the primary-FRN pick rests on an assertion this SAME
 * reader simultaneously reports as no longer in force via `identifiers`/`inferred_links`'s temporal scoping — a direct
 * self-contradiction.
 *
 * A `frn` with no in-force filing `asOf` the given date contributes no candidate at all (not an error — see
 * {@linkcode filerLookup}'s "no candidates" handling).
 */
export async function readFRNFilingCandidates(
	db: DatabaseClient<FilerDatabase>,
	frns: readonly FRN[],
	asOf: string
): Promise<FRNFilingRecord[]> {
	const candidates: FRNFilingRecord[] = []

	for (const frn of frns) {
		const frnNodeID = `${FilerIdentifierType.FRN}:${frn}`

		const filingEdges = await db
			.selectFrom("filer_edge")
			.select(["valid_from"])
			.where("assertion", "=", FilerEdgeAssertion.Authoritative)
			.where("source", "=", "form-499")
			.where("from_node_id", "=", frnNodeID)
			.where("valid_from", "<=", asOf)
			.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
			.execute()

		if (!filingEdges.length) continue

		let latestFiledAt = filingEdges[0]!.valid_from

		for (const edge of filingEdges) {
			if (edge.valid_from > latestFiledAt) {
				latestFiledAt = edge.valid_from
			}
		}

		candidates.push({ frn, filedAt: latestFiledAt })
	}

	return candidates
}

interface QueriedIdentifier {
	nodeID: string
	type: string
	value: string
}

/**
 * XOR discipline (matching `filingLandscape`'s `queryModeCount` check) plus node-id minting for whichever of
 * `frn`/`form499ID`/`bdcProviderID` was supplied.
 */
function resolveQueriedIdentifier(query: FilerLookupQuery): QueriedIdentifier {
	const suppliedCount =
		(query.frn !== undefined ? 1 : 0) +
		(query.form499ID !== undefined ? 1 : 0) +
		(query.bdcProviderID !== undefined ? 1 : 0)

	if (suppliedCount !== 1) {
		throw new Error("filerLookup: exactly one of `frn`, `form499ID`, `bdcProviderID` is required")
	}

	if (query.frn !== undefined) {
		return { nodeID: `${FilerIdentifierType.FRN}:${query.frn}`, type: FilerIdentifierType.FRN, value: query.frn }
	}

	if (query.form499ID !== undefined) {
		return {
			nodeID: `${FilerIdentifierType.Form499ID}:${query.form499ID}`,
			type: FilerIdentifierType.Form499ID,
			value: query.form499ID,
		}
	}

	const value = String(query.bdcProviderID)

	return { nodeID: `${FilerIdentifierType.BDCProviderID}:${value}`, type: FilerIdentifierType.BDCProviderID, value }
}

/**
 * `new Date().toISOString().slice(0, 10)` — today, as an ISO `YYYY-MM-DD` date string, the same sortable shape every
 * real `valid_from`/`valid_to` in `filer.db` uses. {@linkcode filerLookup}'s default `asOf` when the caller omits one.
 * Exported so `family-rollup.ts` shares this exact definition of "today" rather than growing its own — every reader in
 * this SDK should default `asOf` identically.
 */
export function todayISODate(): string {
	return new Date().toISOString().slice(0, 10)
}

/**
 * Guards a reader that hard-depends on `filer_family` — `filerLookup`'s own `families` field, and `family-rollup.ts`'s
 * `familyRollup` — against an artifact built before that table existed. `filer_family` was introduced at
 * {@link FILER_FAMILY_SCHEMA_VERSION}; an OLDER artifact's `filer.db` has no such table at all, so an unconditional
 * `filer_family` query against one throws a raw, unhelpful "no such table: filer_family" straight from SQLite. Exported
 * (not just called inline in `filerLookup`) so `family-rollup.ts` shares this exact check rather than growing its own —
 * same "one definition, no drift" discipline as {@linkcode todayISODate}.
 */
export function assertFamilySchemaVersion(schemaVersion: number, readerName: string): void {
	if (schemaVersion < FILER_FAMILY_SCHEMA_VERSION) {
		throw new Error(
			`${readerName}: filer.db schema_version ${schemaVersion} predates filer_family (introduced at ` +
				`schema_version ${FILER_FAMILY_SCHEMA_VERSION}) — rebuild this artifact via ` +
				"buildFilerDatabase to pick up the current schema before querying it with this reader."
		)
	}
}

/**
 * One `filer_family` membership row's full shape — every field {@linkcode readFamilyDisplayNames} needs to find the
 * SPECIFIC `filer_edge` row that implied this exact membership fact. Deliberately not the public
 * `FilerLookupFamily`/`FamilyRollupMember` shapes (`family-rollup.ts`) — those omit `valid_from` on purpose (never
 * asked for on the public surface); this internal shape carries it because the display-name join needs it.
 */
export interface FamilyMemberRow {
	node_id: string
	/**
	 * The company node whose raw name PRODUCED this row's `family_id`, persisted by the builder (`schema.ts`'s
	 * `FilerFamilyTable.naming_node_id`). This is what {@linkcode readFamilyDisplayNames} joins on, so no reader has to
	 * re-canonicalize edge targets to find its way back to the name.
	 */
	naming_node_id: string
	relationship: string
	/**
	 * One of {@link FilerEdgeAssertion} — surfaced onward as `FamilyRollupMember.assertion` (`family-rollup.ts`).
	 * Deliberately NOT part of {@linkcode readFamilyDisplayNames}'s edge join: that join's authoritative-only rule (with
	 * its one documented EDGAR widening) is a rule about which names may be presented as DOCUMENTED, and matching it to
	 * the family row's own assertion instead would silently admit every future name-similarity-inferred edge the rule
	 * exists to keep out.
	 */
	assertion: string
	source: string
	valid_from: string
	match_score: number | null
}

/**
 * Read every `filer_family` row for `familyID`, in force `asOf` the query date — the SAME half-open predicate as
 * everywhere else in this module. Shared by `filerLookup`'s `families` field and `family-rollup.ts`'s `familyRollup` so
 * "who are this family's current members" has exactly one implementation, not two copies that could drift the way
 * independently written copies of the asOf predicate itself have.
 */
export async function readFamilyMembers(
	db: DatabaseClient<FilerDatabase>,
	familyID: string,
	asOf: string
): Promise<FamilyMemberRow[]> {
	// The sort is the full primary key minus `family_id` (which this query pins), so the result is TOTALLY ordered:
	// `node_id` alone is not, because one member can carry several rows in the same family — reporting it under two
	// SOURCES, or one row per raw spelling (see `createFilerFamilyTable`'s PK docstring, `schema.ts`). The sharp case
	// is gate 2's own fixture: two rows for one member differing only in `assertion`, hence in `source`, which only
	// the last two keys here separate. `FamilyRollup.members`' positional assertions depend on this total order.
	return db
		.selectFrom("filer_family")
		.select(["node_id", "naming_node_id", "relationship", "assertion", "source", "valid_from", "match_score"])
		.where("family_id", "=", familyID)
		.where("valid_from", "<=", asOf)
		.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
		.orderBy("node_id")
		.orderBy("naming_node_id")
		.orderBy("source")
		.orderBy("valid_from")
		.execute()
}

/**
 * Read the DISTINCT set of raw `identifier_value` spellings a family's members' own holding-/management-company edges
 * point to (the family_id alone is a canonicalized slug; this recovers the human-readable name(s) that produced it —
 * without it the headline "these filers report holding company H" output has only a normalization key, and no way back
 * to a name anyone actually filed). For each member row, reads the ONE `filer_edge` the builder wrote in lockstep with
 * it: the edge from that member to the member row's own `naming_node_id`, under the same `(relationship, source,
 * valid_from)` — `filer_edge`'s PK is `(from_node_id, to_node_id, source, valid_from)`, so pinning `to_node_id` makes
 * this an exact, single-row probe — then that edge's target node's raw `identifier_value`.
 *
 * **The naming provenance is READ, never re-derived.** The obvious alternative — call `mintFamilyID` HERE, at read
 * time, and keep only the edges whose target canonicalizes back to the `familyID` being computed — gets the same
 * scoping, and is correct on the day it is written. It also couples a sealed, shipped, separately-versioned `filer.db`
 * to whatever `canonicalizeOrganizationName` (`@mailwoman/record`) happens to do in the READER'S build, with nothing
 * pinning the two together: `filer_manifest` carries `schema_version`/`build_sha`/`source_vintage` but no canonicalizer
 * identity, and `FILER_FAMILY_SCHEMA_VERSION` would not move for a designation-list edit in another workspace. A
 * reviewer reproduced the consequence: rewrite one persisted `family_id` to what a canonicalizer one designation-token
 * older would have minted (node, edge and membership all intact) and every `display_names` on both surfaces silently
 * empties — no error, no warning, the name simply gone. `filer_family.naming_node_id` carries that fact from BUILD time
 * instead, which is also the plainly correct shape under this project's binding rule (provenance on every edge): a
 * membership row must not record the fact without recording what produced it.
 *
 * **`assertion: "authoritative"` is required — EXCEPT for EDGAR's own source.** The general rule is binding: a
 * `display_names` entry is presented as a DOCUMENTED name this family's members actually reported, so an edge inferred
 * by a NAME-SIMILARITY MATCH (a future fuzzy matcher's guess at "these two spellings probably name the same holding
 * company", say) must never surface here — that would restate a guess as a filing, and a dedicated regression test
 * (`family-rollup.test.ts`) pins exactly that case. EDGAR's subsidiary-name→FRN corroboration (`build-filer.ts`) is a
 * different shape of inference: the NAME itself is never guessed — it is the CIK's OWN node id, established by that
 * SAME builder's authoritative disclosure edge (`cik -> subsidiaryNameNode`) elsewhere in the graph — only WHICH FRN
 * that already-authoritative name belongs to is inferred. So `source = "edgar-exhibit-21"` is the one case an
 * `assertion: "inferred"` edge is admitted here too; every other source keeps the strict authoritative-only rule.
 *
 * **Never collapsed to one value within the SAME family.** When two raw spellings both canonicalize to one `family_id`
 * (e.g. `"Acme Corp"` and `"Acme Corporation, LLC"` both reduce to `"acme"`), BOTH survive here, sorted for a
 * deterministic result — the same "expose the plurality, never guess which one is right" doctrine every other reader in
 * this SDK follows (`identifiers`' cardinality fidelity, `inferred_links` kept separate from `cluster`, `filer_family`
 * member provenance never deduped). Picking one would silently assert an opinion about which spelling is "correct" that
 * `filer.db` itself has no grounds to hold — the same-name/different-entity hazard this phase keeps re-discovering is
 * mirrored exactly by a same-entity/different-name shortcut here. That plurality is why `naming_node_id` is part of
 * `filer_family`'s primary key rather than a mere payload column: the two spellings differ in nothing else, so a
 * narrower key would let `INSERT OR IGNORE` drop the second at build time and lose it before any reader ever ran (see
 * `createFilerFamilyTable`'s docstring, `schema.ts`).
 */
export async function readFamilyDisplayNames(
	db: DatabaseClient<FilerDatabase>,
	members: readonly FamilyMemberRow[]
): Promise<string[]> {
	const displayNames = new Set<string>()

	for (const member of members) {
		const edgeRows = await db
			.selectFrom("filer_edge")
			.innerJoin("filer_node", "filer_node.node_id", "filer_edge.to_node_id")
			.select("filer_node.identifier_value")
			.where("filer_edge.from_node_id", "=", member.node_id)
			// THE JOIN: the builder's own record of WHICH company node named this family — read,
			// not recomputed. See the docstring above.
			.where("filer_edge.to_node_id", "=", member.naming_node_id)
			// The EDGAR-only widening — see the docstring above for why every other source keeps the strict
			// authoritative-only rule.
			.where((eb) =>
				eb.or([
					eb("filer_edge.assertion", "=", FilerEdgeAssertion.Authoritative),
					eb.and([
						eb("filer_edge.assertion", "=", FilerEdgeAssertion.Inferred),
						eb("filer_edge.source", "=", "edgar-exhibit-21"),
					]),
				])
			)
			.where("filer_edge.relationship", "=", member.relationship)
			.where("filer_edge.source", "=", member.source)
			.where("filer_edge.valid_from", "=", member.valid_from)
			.execute()

		for (const row of edgeRows) {
			displayNames.add(row.identifier_value)
		}
	}

	return [...displayNames].toSorted()
}

function otherEndOf(edge: { from_node_id: string; to_node_id: string }, nodeID: string): string {
	return edge.from_node_id === nodeID ? edge.to_node_id : edge.from_node_id
}

/**
 * Look up a node in `byID`, throwing on a miss — every `filer_edge` row this reader touches MUST resolve to a real
 * `filer_node` row on both ends (referential integrity `filer.db`'s builder guarantees by construction); a miss means a
 * corrupted crosswalk, not a legitimate "not found" case, so this is loud rather than silently dropping the
 * identifier.
 */
function nodeOrThrow(byID: ReadonlyMap<string, FilerNodeTable>, nodeID: string): FilerNodeTable {
	const node = byID.get(nodeID)

	if (!node) {
		throw new Error(
			`filerLookup: filer_edge references node_id ${JSON.stringify(nodeID)} with no matching filer_node row — corrupted crosswalk`
		)
	}

	return node
}

/**
 * Filters a `filer_cluster` cluster's STATIC member list down to the subset reachable from the queried node via
 * `assertion: "authoritative"` `filer_edge` rows in force `asOf` a date (`filer_cluster` asOf-scoping). `filer_cluster`
 * itself carries no temporal columns at all (`schema.ts`) — `clusterAuthoritativeComponents` (`cluster-filers.ts`)
 * recomputes it from whatever the CURRENT edge graph looks like on every run, with no `asOf` concept of its own. Left
 * unguarded, `filerLookup`'s `cluster` field would report full present-day membership at ANY `asOf` date, directly
 * contradicting `identifiers`'s own `asOf` scoping — reviewer probe: `asOf 2020-01-01` returned `identifiers: []`
 * (nothing in force that early) yet `cluster` still asserted two members were one entity, the same self-contradiction
 * the primary-FRN temporal fix (see {@linkcode readFRNFilingCandidates}'s docstring) closed for that probe.
 *
 * Bounded to the CANDIDATE members `filer_cluster` already names — a plain `WHERE from_node_id/to_node_id IN
 * (candidateMembers)` query, not a whole-graph traversal. Re-deriving the entire authoritative component graph from
 * scratch on every READ (the way `cluster-filers.ts`'s own `readAuthoritativeGroups` does on every clustering RUN)
 * would be redundant work and a real perf regression for a large crosswalk; restricting the BFS to the snapshot's own
 * member list keeps this a small, node-local query, matching every other query in this reader.
 *
 * Returns `null` when the queried node has NO authoritative edge, among this candidate set, in force `asOf` the date —
 * i.e. nothing here corroborates the snapshot's cluster assignment as of that date, so this reports "no cluster
 * observed" rather than asserting one the caller has no `asOf`-scoped evidence for. Otherwise returns the reachable
 * subset, sorted (mirrors `cluster-filers.ts`'s own `.orderBy("node_id")`/`.toSorted()` convention) — which may be a
 * PROPER subset of `candidateMembers` when the full component only partially held together as of that date.
 *
 * `relationship: "same_entity"` is required on this edge query too — the same fix `cluster-filers.ts`'s
 * `readAuthoritativeGroups` needed, for the identical reason: without it, a HoldingCompany/ManagementCompany edge
 * between two of `candidateMembers` (in practice, this can only ever be the writer-bug case this fix closes — a
 * same-entity cluster snapshot should never legitimately contain a holding-/management-company node as a member once
 * `readAuthoritativeGroups` is fixed) could corroborate a cross-entity link this asOf-scoping pass is supposed to be
 * validating, not merely re-deriving unfiltered.
 */
async function deriveClusterMembersAsOf(
	db: DatabaseClient<FilerDatabase>,
	nodeID: string,
	candidateMembers: readonly string[],
	asOf: string
): Promise<string[] | null> {
	// A singleton candidate set (nodeID alone, no other member ever shared this authoritative component) asserts no
	// cross-node relationship to corroborate against `asOf` in the first place — `null`, not a trivial one-member
	// cluster, matching this reader's existing "no authoritative cluster assignment" null case.
	if (candidateMembers.length <= 1) return null

	const edges = await db
		.selectFrom("filer_edge")
		.select(["from_node_id", "to_node_id"])
		.where("assertion", "=", FilerEdgeAssertion.Authoritative)
		.where("relationship", "=", FilerRelationship.SameEntity)
		.where("from_node_id", "in", candidateMembers)
		.where("to_node_id", "in", candidateMembers)
		.where("valid_from", "<=", asOf)
		.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
		.execute()

	const adjacency = new Map<string, Set<string>>(candidateMembers.map((member) => [member, new Set<string>()]))

	for (const edge of edges) {
		adjacency.get(edge.from_node_id)?.add(edge.to_node_id)
		adjacency.get(edge.to_node_id)?.add(edge.from_node_id)
	}

	const visited = new Set<string>([nodeID])
	const queue = [nodeID]

	while (queue.length) {
		const current = queue.shift()!

		for (const neighbor of adjacency.get(current) ?? []) {
			if (!visited.has(neighbor)) {
				visited.add(neighbor)
				queue.push(neighbor)
			}
		}
	}

	if (visited.size <= 1) return null

	return [...visited].toSorted()
}

/**
 * Validates an `identifiers[]` entry's `value` is a real {@link FRN} before it feeds
 * {@linkcode readFRNFilingCandidates} — a bare `identifier.value as FRN` type assertion would claim the shape without
 * ever checking it. Every `frn`-typed `identifiers[]` entry is minted from a `filer_node.identifier_value` that the
 * builder only ever writes via {@linkcode mintFRNNodeID}/{@linkcode toFRN} (`build-filer.ts`, `frn.ts`) — a real FRN
 * value here is an invariant the crosswalk's own writers guarantee, not a possibility this reader ought to silently
 * trust. A miss means a corrupted crosswalk, the same class of failure {@linkcode nodeOrThrow} guards against, so this
 * is loud rather than passing a malformed value into the filing-candidate query.
 */
function assertFRNIdentifier(value: string): FRN {
	if (!isFRN(value)) {
		throw new Error(
			`filerLookup: an frn-typed identifier carries ${JSON.stringify(value)}, which is not a valid FRN ` +
				`(expected a zero-padded 10-digit string) — corrupted crosswalk`
		)
	}

	return value
}

/**
 * Read the identity crosswalk for one identifier — see the module docstring for the full contract (XOR query,
 * manifest-first, temporal scoping, the authoritative/inferred split, and the primary-FRN rule).
 */
export async function filerLookup(
	db: DatabaseClient<FilerDatabase>,
	query: FilerLookupQuery
): Promise<FilerLookupResult> {
	const { nodeID, type, value } = resolveQueriedIdentifier(query)

	// Manifest-first (gate 4): throws before any node/edge query runs at all — this reader never answers unstamped.
	const manifest = await readFilerManifest(db)

	// Refuse a pre-filer_family artifact with a descriptive error rather than the raw
	// "no such table" the unconditional families query below would otherwise surface.
	assertFamilySchemaVersion(manifest.schema_version, "filerLookup")

	const asOf = query.asOf ?? todayISODate()

	const node = await db.selectFrom("filer_node").selectAll().where("node_id", "=", nodeID).executeTakeFirst()

	if (!node) {
		throw new Error(`filerLookup: no ${type} node found for value ${JSON.stringify(value)}`)
	}

	// Gate 4: temporal scoping. valid_from <= asOf AND (valid_to IS NULL OR asOf < valid_to) — see the module
	// docstring. Applied identically to the authoritative edges below and the inferred edges further down.
	//
	// relationship = same_entity is ALSO required — identifiers answers "which other
	// identifiers denote this SAME entity", never "everything this node has an authoritative edge to regardless of
	// what that edge means". Without this filter a HoldingCompany/ManagementCompany edge (correctly authoritative)
	// surfaces the holding company's NAME here as if it were this filer's own identifier — see the module
	// docstring.
	const authoritativeEdges = await db
		.selectFrom("filer_edge")
		.selectAll()
		.where("assertion", "=", FilerEdgeAssertion.Authoritative)
		.where("relationship", "=", FilerRelationship.SameEntity)
		.where((eb) => eb.or([eb("from_node_id", "=", nodeID), eb("to_node_id", "=", nodeID)]))
		.where("valid_from", "<=", asOf)
		.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
		.execute()

	const otherNodeIDs = new Set(authoritativeEdges.map((edge) => otherEndOf(edge, nodeID)))

	const otherNodes = otherNodeIDs.size
		? await db
				.selectFrom("filer_node")
				.selectAll()
				.where("node_id", "in", [...otherNodeIDs])
				.execute()
		: []

	const nodeByID = new Map(otherNodes.map((n) => [n.node_id, n] as const))

	// Gate 3 (cardinality fidelity): every authoritative edge becomes its own identifiers[] entry — a
	// bdcProviderID carrying two FRN edges reports BOTH, never collapsed/deduped.
	const identifiers: FilerLookupIdentifier[] = authoritativeEdges.map((edge) => {
		const otherNode = nodeOrThrow(nodeByID, otherEndOf(edge, nodeID))

		return {
			type: otherNode.identifier_type,
			value: otherNode.identifier_value,
			source: edge.source,
			source_vintage: edge.source_vintage,
		}
	})

	const attributeRows = await db.selectFrom("filer_attribute").selectAll().where("node_id", "=", nodeID).execute()

	const latestAttributeByKey = new Map<string, { value: string; vintage: string }>()

	for (const row of attributeRows) {
		const current = latestAttributeByKey.get(row.key)

		if (!current || row.source_vintage > current.vintage) {
			latestAttributeByKey.set(row.key, { value: row.value, vintage: row.source_vintage })
		}
	}

	const attributes: Record<string, string> = {}

	for (const [key, { value: attrValue }] of latestAttributeByKey) {
		attributes[key] = attrValue
	}

	// Gate 2: `cluster` is read ONLY from assertion = 'authoritative' rows — see the module docstring.
	const clusterRow = await db
		.selectFrom("filer_cluster")
		.selectAll()
		.where("node_id", "=", nodeID)
		.where("assertion", "=", FilerEdgeAssertion.Authoritative)
		.executeTakeFirst()

	let cluster: FilerLookupCluster | null = null

	if (clusterRow) {
		const memberRows = await db
			.selectFrom("filer_cluster")
			.select("node_id")
			.where("cluster_id", "=", clusterRow.cluster_id)
			.where("assertion", "=", FilerEdgeAssertion.Authoritative)
			.orderBy("node_id")
			.execute()

		// filer_cluster carries no temporal columns of its own — restrict the static
		// snapshot's membership down to whatever's actually corroborated by an authoritative edge in force `asOf`
		// this query's date, so `cluster` can never contradict `identifiers`'s own asOf scoping. See
		// deriveClusterMembersAsOf's docstring.
		const membersAsOf = await deriveClusterMembersAsOf(
			db,
			nodeID,
			memberRows.map((row) => row.node_id),
			asOf
		)

		if (membersAsOf) {
			cluster = { cluster_id: clusterRow.cluster_id, members: membersAsOf }
		}
	}

	// Gate 2: `inferred_links` is read ONLY from assertion = 'inferred' rows, entirely separately from `cluster`
	// above — the two never share a query, so an inferred edge can never leak into the authoritative view.
	const inferredEdges = await db
		.selectFrom("filer_edge")
		.selectAll()
		.where("assertion", "=", FilerEdgeAssertion.Inferred)
		.where((eb) => eb.or([eb("from_node_id", "=", nodeID), eb("to_node_id", "=", nodeID)]))
		.where("valid_from", "<=", asOf)
		.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
		.execute()

	const inferred_links: FilerLookupInferredLink[] = inferredEdges.map((edge) => ({
		to: otherEndOf(edge, nodeID),
		score: edge.match_score,
		source: edge.source,
	}))

	// Gate 1 (3b, load-bearing): `families` is read from `filer_family` ONLY — an entirely separate query from
	// `cluster`'s filer_cluster/filer_edge path above and from `inferred_links`'s filer_edge path just above this. No
	// function in this reader touches both a cluster source and a family source, so a family membership can never be
	// returned as a cluster member, and vice versa. Same half-open asOf predicate as everywhere else in this module.
	//
	// `.distinct`: two `filer_family` rows differing ONLY in fields this shape cannot express
	// — `naming_node_id`/`source`/`valid_from`, i.e. the same node reporting one family under two spellings, or two
	// sources corroborating one membership — would otherwise emit byte-identical duplicate entries here, which convey
	// nothing a caller can act on. That plurality IS exposed, on the surfaces that can express it: `display_names`
	// below (every spelling) and `familyRollup`'s per-member `source` (every asserting source). A PK wide enough to
	// admit the second spelling must not turn into a duplicated answer on a field with nowhere to put the difference.
	//
	// `assertion`/`match_score` are in the projection AND therefore in the dedup key: an authoritative
	// membership and an inferred one for the same family are two DIFFERENT claims, and collapsing them would restate
	// exactly the conflation `assertion` exists to end. The order-by covers them too, so the result
	// stays totally ordered over the projected tuple, which `.distinct()` makes unique.
	const familyRows = await db
		.selectFrom("filer_family")
		.select(["family_id", "relationship", "assertion", "match_score"])
		.distinct()
		.where("node_id", "=", nodeID)
		.where("valid_from", "<=", asOf)
		.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
		.orderBy("family_id")
		.orderBy("relationship")
		.orderBy("assertion")
		.orderBy("match_score")
		.execute()

	// display_names is a FAMILY-WIDE fact (every current member's own raw spelling), not just
	// this node's — so each distinct family_id needs its own member fetch, not just the one row above. Plain loop,
	// not .map(), since readFamilyDisplayNames is async.
	const families: FilerLookupFamily[] = []

	for (const row of familyRows) {
		const familyMembers = await readFamilyMembers(db, row.family_id, asOf)
		const displayNames = await readFamilyDisplayNames(db, familyMembers)

		families.push({
			family_id: row.family_id,
			relationship: row.relationship,
			assertion: row.assertion,
			match_score: row.match_score,
			display_names: displayNames,
		})
	}

	// Gate 3 / decision 6: when the queried node carries more than one FRN identifier (the multi-FRN provider_id
	// cardinality case), pick a primary via each FRN's own most recent form-499 filing edge. Reported as its OWN
	// top-level field (never folded into `attributes`) — see the module docstring's "A derived conclusion…" section.
	const frnIdentifiers = identifiers.filter((identifier) => identifier.type === FilerIdentifierType.FRN)

	let primaryFRN: FilerLookupPrimaryFRN | null = null

	if (frnIdentifiers.length > 1) {
		const candidates = await readFRNFilingCandidates(
			db,
			frnIdentifiers.map((identifier) => assertFRNIdentifier(identifier.value)),
			asOf
		)

		if (candidates.length) {
			primaryFRN = { frn: pickPrimaryFRN(candidates), derived_from: PRIMARY_FRN_DERIVATION, as_of: asOf }
		}
	}

	return {
		node,
		identifiers,
		attributes,
		cluster,
		inferred_links,
		families,
		primary_frn: primaryFRN,
		as_of: asOf,
		vintage: manifest.source_vintage,
	}
}
