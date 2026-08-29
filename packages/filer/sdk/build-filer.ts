/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `filer.db` builder — ingests {@link Form499Row} and {@link ProviderListRow} into the schema
 *   (`../schema.ts`), producing a sealed identity-crosswalk artifact. Copies `bdc/sdk/build-bdc.ts`'s flow
 *   verbatim: `${out}.building` → build-tuning pragmas → ONE `DatabaseSync` handle wrapped in a
 *   `DatabaseClient` for DDL while hot inserts use raw prepared statements on that SAME handle → create
 *   tables → stage-table dedup via composite-PK `INSERT OR IGNORE` batched with `BEGIN`/`COMMIT` →
 *   materialize via `INSERT … SELECT` → index-after-load → write manifest → `ANALYZE`/`VACUUM` →
 *   `sealDatabase` → rename existing `out` to `.prev` → rename `.building` into place. `filer.db` is NOT a
 *   layer-contract artifact (decision 2), so there is no `@mailwoman/core/layers` call here and no
 *   `asContractDB`-style invariance cast is needed — the manifest is a plain `filer_manifest` insert via
 *   Kysely, not `writeLayerManifest`.
 *
 *   **Node/edge/family dedup — no staging table needed.** `filer_node` (PK `node_id`), `filer_edge` (PK
 *   `(from_node_id, to_node_id, source, valid_from)`), and `filer_family` (PK `(node_id, family_id,
 *   naming_node_id, source, valid_from)` — the edge key's four columns plus `naming_node_id`, so two raw
 *   spellings that canonicalize to one `family_id` stay two rows instead of colliding; see
 *   `createFilerFamilyTable`'s PK docstring in `schema.ts` for why that placement is required) already
 *   carry the uniqueness constraint a staging table would otherwise exist to provide — so all three are
 *   written directly via raw prepared `INSERT OR IGNORE` against the PRODUCTION table. The composite PK, not
 *   a separate staging pass, is the dedup mechanism, and the family-membership writes reuse it rather than
 *   growing a second staging table the PK already makes unnecessary.
 *
 *   **Attribute dedup — a real staging table, because `filer_attribute` has no PK.** Neither
 *   `filer_attribute` nor `filer_cluster` carries a uniqueness constraint, so a same-source/ same-vintage
 *   double-insert (e.g. the same 499 row processed twice, or two rows independently asserting the identical
 *   fact) would silently duplicate. This builder makes the write path idempotent by staging every attribute
 *   write into `filer_attribute_stage` — a build-only table (dropped before the artifact seals, same
 *   lifecycle as `bdc_stage`) carrying a composite PRIMARY KEY on the natural key `(node_id, key, value,
 *   source, source_vintage)` — then materializing into `filer_attribute` via `INSERT … SELECT`. `value` is
 *   part of the key (not just `node_id, key, source, source_vintage`) because ONE key can legitimately carry
 *   several distinct values from the same source at the same vintage (e.g. `classification` — a filer can be
 *   both a USF contributor AND an Incumbent LEC); only a literal repeat of the whole tuple is a duplicate to
 *   collapse.
 *
 *   `filer_cluster` is created (empty) for schema completeness — `cluster-filers.ts` populates it in a later
 *   build pass; this builder never writes to it, so its own PK-less idempotency question is out of scope
 *   here.
 *
 *   **Malformed input is loud, never silently deduped** (`peekProviderID`'s discipline,
 *   `bdc/sdk/build-bdc.ts`:237): an empty `form499ID` cannot be told apart from any other empty `form499ID`
 *   once mangled into a node identity — silently accepting it would mint ONE degenerate `form499_id:` node
 *   that every empty-ID row collapses into, merging unrelated filers under one identity. This throws instead,
 *   naming the offending row. Likewise an empty `frn` (on EITHER row shape — see {@linkcode mintFRNNodeID})
 *   and an empty `lastFiledAt` (see {@linkcode assertLastFiledAt}: an unguarded blank `lastFiledAt` reaches
 *   `source_vintage`/`valid_from` as `""`, which SQLite's `NOT NULL` does not reject, breaking decision 7 /
 *   gate 1's "valid_from is MANDATORY" invariant). A `null` {@link Form499Row.frn} is the opposite case —
 *   common and legitimate (a filer not yet registered in CORES) — so it is never an error, only a counted
 *   {@link BuildFilerResult.skipped} opportunity.
 *
 *   **Edges emitted from the 499 and provider-list rows (all `assertion: "authoritative"` — the only INFERRED
 *   edge this builder writes is the EDGAR corroboration edge below; every other inferred edge in `filer.db`
 *   comes from `cluster-filers.ts`, over `@mailwoman/match`):**
 *
 *   - From a {@link Form499Row} with a non-null `frn`: `FRN↔form499ID`, `FRN↔holdingCompanyName` (when
 *     `holdingCompany` is non-empty), `FRN↔managementCompanyName` (when `managementCompany` is
 *     non-empty — a SEPARATE edge from the holding-company one; spec §3.1 finding 1, ownership and
 *     operational control are different assertions, never collapsed). `source_vintage` and `valid_from`
 *     both take the row's own `lastFiledAt` (decision 7 — the only per-row date 499 offers).
 *   - From a {@link ProviderListRow}: `bdcProviderID↔FRN` (always — `frn` is never null on this row shape)
 *     and `bdcProviderID↔holdingCompanyName` (when `holdingCompany` is non-null). `source_vintage` takes
 *     `options.sourceVintage` (decision 7 — the provider list carries no per-row date, only a whole-file
 *     vintage) but `valid_from` takes the SEPARATE `options.validFrom` — see {@link
 *     BuildFilerOptions.validFrom}'s docstring for why the two must never be the same field: `sourceVintage`
 *     is a free-text human label (`"2026-Q2"`) that is not guaranteed ISO-sortable, and `valid_from`
 *     participates in every downstream `asOf` predicate as a plain string comparison.
 *
 *   The direction convention (documented, not semantically required — `filer_edge` asserts symmetric
 *   sameness, and the `to_node_id` index makes either traversal direction cheap): FRN is `from` for
 *   499-derived edges (it is the identifier hub — spec §3), `bdcProviderID` is `from` for provider-list
 *   edges (the row's own natural anchor).
 *
 *   **`relationship` is fully typed (decisions 1, 2) — every edge below names its own kind, never a uniform
 *   `SameEntity` placeholder.** `FRN↔form499ID` and `bdcProviderID↔FRN` assert identity — the same underlying
 *   filer under a different identifier — so both stay `FilerRelationship.SameEntity`.
 *   `FRN↔holdingCompanyName` AND `bdcProviderID↔holdingCompanyName` are ownership facts
 *   (`FilerRelationship.HoldingCompany`); `FRN↔managementCompanyName` is operational control, never collapsed
 *   into the holding-company kind (spec §3.1 finding 1) — `FilerRelationship.ManagementCompany`.
 *
 *   **`filer_family` is populated alongside every `HoldingCompany`/`ManagementCompany` edge.** A
 *   `holding_company_name` (or `management_company_name`) node with N distinct FRN/`bdcProviderID` members
 *   pointing at it is a corporate family of N members — {@linkcode mintFamilyID} derives a stable
 *   `family_id` from the target name's CANONICAL form (`canonicalizeOrganizationName`, `@mailwoman/record`
 *   — the same reduction `cluster-filers.ts`'s inferred pass already relies on), namespaced by identifier
 *   type so a holding company and a differently-named management company never collapse into one family
 *   even if their canonical strings happened to coincide. Each `filer_family` row carries the SAME
 *   `assertion`/`relationship`/`source`/`source_vintage`/`valid_from` as the edge that implies it, that edge's
 *   `to_node_id` as its `naming_node_id` (the naming provenance, persisted here so no
 *   reader has to re-canonicalize a sealed artifact's names to find its way back to them), and
 *   `valid_to: null` (a fresh assertion, never pre-closed). **Never derived from a DC-agent field** — see
 *   the DC-agent doctrine below; those fields never reach an edge, so by construction they can never reach
 *   a family either.
 *
 *   **DC-agent doctrine (spec §3.1 finding 3, repeated here because it is easy to violate by accident):**
 *   `dcAgent*` fields are recorded ONLY as `filer_attribute` rows (`dc_agent_display_name`,
 *   `dc_agent_organization_name`, `dc_agent_telephone`, `dc_agent_email_address`, `dc_agent_address`).
 *   They NEVER produce a `filer_edge` — a shared registered agent (CT Corporation, CSC, Cogency Global
 *   dominate this role across tens of thousands of unrelated filers) is the single most likely
 *   false-positive generator in the whole crosswalk design. There is no code path here that could turn a
 *   `dcAgent*` field into an edge; this is enforced by construction (the edge-emitting functions below
 *   never read those fields), not by a runtime check.
 *
 *   **EDGAR Exhibit 21 ingest — the optional `edgarRows` seam.** `sec-client.ts`'s `SECClient.getDocument`
 *   plus `exhibit21.ts`'s `parseExhibit21` produce {@link EdgarSubsidiaryRow}s (a parent CIK, a raw
 *   subsidiary name, an optional jurisdiction, a filing date) somewhere upstream of this file; this builder
 *   only ever consumes them, the same "injected iterable" shape `form499Rows`/`providerRows` already use.
 *
 *   Two edges per row, at most, and they answer DIFFERENT questions:
 *
 *   1. **The disclosure edge — ALWAYS written, ALWAYS authoritative.** `cik -> subsidiaryNameNode`,
 *      `relationship: Subsidiary` (schema.ts's convention: the TARGET is what it is TO the SOURCE, so
 *      `cik`'s target being "my subsidiary" is exactly `Subsidiary`, matching the plan's own "Parent CIK →
 *      subsidiary name becomes a Subsidiary family edge" wording), `source: "edgar-exhibit-21"`,
 *      `source_vintage`/`valid_from` both the row's `filingDate`. Exhibit 21 is the filer's own filed
 *      statement that a subsidiary by this name exists — that fact is authoritative regardless of whether
 *      this builder can also work out WHICH registrant, if any, it corresponds to. `subsidiaryNameNode` is
 *      minted the same "global name-node" way as `mintHoldingCompanyNodeID` — the raw string, unnormalized;
 *      see {@link FilerIdentifierType.SubsidiaryName}'s own docstring in `schema.ts`.
 *   2. **The corroboration edge — INFERENCE, not authority, and only when unambiguous.** Which FRN (if any) a
 *      disclosed subsidiary name actually IS is not itself in Exhibit 21 — this builder infers it by an EXACT
 *      canonicalized-name match against the `legalNameOfCarrier` this SAME build call's `form499Rows` already
 *      gave it (cluster-filers.ts's own inferred pass makes the identical simplification, for the identical
 *      reason: "nothing below an exact canonical match ever reaches the scorer"). When EXACTLY ONE FRN's
 *      latest legal name canonicalizes to the subsidiary name, this writes `frn -> cik`, `assertion:
 *      inferred`, `relationship: ParentCompany` (the inverse direction from edge 1 — `from: frn -> to: cik`
 *      with `Subsidiary` would assert the CIK is the FRN's subsidiary, the wrong way round; `ParentCompany`
 *      is what "the target is my parent" means here — the exact shape `filer/tools/linkage-eval.test.ts`
 *      pins), carrying the `match_score` {@linkcode scoreEdgarSubsidiaryMatch} computes from the two RAW
 *      names. When ZERO FRNs match, nothing more is written — the disclosure edge above is the whole fact.
 *      When TWO OR MORE DISTINCT FRNs canonicalize to the SAME name (a genuine collision — 3a's
 *      false-identity-link lesson, `edgar-filings.ts`'s own `resolveCIKCandidates` docstring), this builder
 *      ABSTAINS rather than guess which one: no corroboration edge, no family row, for that subsidiary.
 *
 *      **The score is NOT a constant.** One flat number on every such link would overstate the ambiguous case
 *      badly: the join is on the CANONICALIZED name, and `canonicalizeOrganizationName` maps `"American
 *      Broadband LLC"`, `"American Broadband, Inc."` and `"American Broadband Corp"` all to `"american
 *      broadband"` — so the match provably cannot tell three companies apart. The abstention above does not
 *      cover that case, because it only fires on a collision WITHIN the 499 file: if 499 carries only the LLC
 *      and Exhibit 21 discloses the Inc., exactly one FRN matches and an edge is written for what may be the
 *      wrong company; that edge scores 0.5. See `scoreEdgarSubsidiaryMatch` (`build/edgar-match.ts`) for the
 *      three-rung ladder and its ceiling.
 *
 *   **A `filer_family` row is written ALONGSIDE the corroboration edge — never for the disclosure edge
 *   alone.** A `filer_edge` row by itself is invisible to `familyRollup`/`filerLookup.families` — both answer
 *   "which family does this node belong to" from `filer_family` alone, which is why the same fact must be
 *   written to both tables (`filer/tools/linkage-eval.test.ts` pins it as a regression test). So the SAME
 *   inferred FRN↔CIK relationship also becomes a `filer_family` row: `node_id` the FRN node, `family_id` AND
 *   `naming_node_id` both the CIK's OWN node id (`insertFamilyMembership`'s usual `mintFamilyID`
 *   canonicalization is not needed here — a CIK is already a stable, EDGAR-assigned, collision-free key,
 *   unlike a free-text holding-company name that two different spellings can drift across), `relationship:
 *   ParentCompany`, same `assertion: inferred`/`match_score`/`source`/`source_vintage`/`valid_from` as the
 *   edge, `valid_to: null`. This is the only INFERRED `filer_family` row anything in the repo writes, and the
 *   reason that table carries `assertion`/`match_score` at all — see `schema.ts`'s file header: without them
 *   this name-match guess reaches `familyRollup`/`filerLookup.families` shape-identical to a Form 499
 *   holding-company membership the filer itself filed.
 *
 *   **`filer.db` is a single-vintage SNAPSHOT, not a multi-vintage archive.** The build-then-seal-then-swap
 *   discipline (`${out}.building` → `sealDatabase` → rename existing `out` to `.prev` → rename into place)
 *   means a SECOND `buildFilerDatabase` call against the SAME `out` with a LATER `sourceVintage` REPLACES the
 *   whole artifact — the earlier vintage's rows do not survive alongside the new ones as additional
 *   `filer_edge`/`filer_attribute` rows. Decision 7's "two vintages can coexist as two rows" scenario is a
 *   property of the SCHEMA (the edge PK includes `valid_from`, so two DIFFERENT `valid_from` values for the
 *   same `(from, to, source)` are two distinct rows) — but it's reachable only by feeding rows spanning
 *   multiple vintages into ONE `buildFilerDatabase` call (e.g. a combined `form499Rows` iterable drawn from
 *   several historical filing snapshots), never by calling this function twice at different `sourceVintage`s
 *   against the same `out`. Any consumer that reads across builds (`cluster-filers.ts`, any future
 *   incremental-build task) must NOT assume cross-build accumulation — each successful build is a complete,
 *   self-contained replacement of what "the crosswalk" means as of that one `sourceVintage`. Multi-vintage
 *   accumulation, if ever needed, would require an accumulate-into-existing-artifact build mode this function
 *   does not implement.
 *
 *   **Where the pieces live.** This file owns the flow above — options validation, the shared `DatabaseSync` handle
 *   and its prepared statements, the three row loops, materialize/index/manifest/seal/swap. The per-row rules live
 *   beside it under `build/`, and every one of them writes through a statement this file prepared rather than opening
 *   anything of its own: `build/node-ids.ts` (how an identifier becomes a `node_id`, and the guards on the values that
 *   reach an identity or temporal column), `build/tables.ts` (the DDL), `build/form499-rows.ts` (one 499 row's
 *   lifecycle, edge and family writes), `build/family-membership.ts` (the `filer_family` row that accompanies an
 *   ownership/control edge), `build/edgar-match.ts` (canonical-name grouping and the match score), and
 *   `build/edgar-rows.ts` (one Exhibit 21 disclosure's two edges).
 */

import { existsSync, mkdirSync, renameSync, rmSync } from "@mailwoman/platform/fs"
import { dirname } from "@mailwoman/platform/path"
import { DatabaseSync } from "@mailwoman/platform/sqlite"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"

import {
	createFilerAttributeNodeIndex,
	createFilerClusterIndex,
	createFilerEdgeToNodeIndex,
	createFilerFamilyIndex,
	FILER_SCHEMA_VERSION,
	FilerEdgeAssertion,
	FilerIdentifierType,
	FilerRelationship,
	type FilerDatabase,
} from "../schema.ts"
import { groupFRNsByCanonicalLegalName } from "./build/edgar-match.ts"
import { processEdgarSubsidiaryRow, type EdgarSubsidiaryRow } from "./build/edgar-rows.ts"
import { insertFamilyMembership } from "./build/family-membership.ts"
import {
	processForm499FRNRelationships,
	processForm499Lifecycle,
	type Form499LifecycleTotals,
} from "./build/form499-rows.ts"
import {
	assertLastFiledAt,
	assertProviderValidFrom,
	mintForm499NodeID,
	mintFRNNodeID,
	mintHoldingCompanyNodeID,
	mintProviderNodeID,
} from "./build/node-ids.ts"
import { createFilerBuildTables } from "./build/tables.ts"
import { classifyFiler, parseForm499, type Form499Row } from "./form499.ts"
import { assertISODate } from "./guards.ts"
import { parseProviderList, type ProviderListRow } from "./provider-list.ts"

// `@mailwoman/filer/sdk/build-filer` is EdgarSubsidiaryRow's published home — `edgar-ingest.ts` and every consumer
// building rows for the `edgarRows` seam import it from here, so it stays exported from this module even though its
// declaration sits with the writer that validates it.
export type { EdgarSubsidiaryRow } from "./build/edgar-rows.ts"

/**
 * Rows committed per `BEGIN`/`COMMIT` batch — matches `build-bdc.ts`'s `STAGE_BATCH_SIZE` discipline. Counted per
 * SOURCE ROW processed (a single 499 row can trigger several node/edge/attribute-stage inserts), not per individual
 * `.run()` call.
 */
const STAGE_BATCH_SIZE = 10_000

export interface BuildFilerOptions {
	/**
	 * Injected Form 499 row source — the test seam. When given, `form499Path` is ignored and no filesystem read happens
	 * for this source.
	 */
	form499Rows?: AsyncIterable<Form499Row> | Iterable<Form499Row>
	/**
	 * Injected provider-list row source — the test seam. When given, `providerListPath` is ignored and no filesystem read
	 * happens for this source.
	 */
	providerRows?: AsyncIterable<ProviderListRow> | Iterable<ProviderListRow>
	/**
	 * Injected EDGAR Exhibit 21 subsidiary-disclosure source — see the module docstring's "EDGAR Exhibit 21 ingest"
	 * section. Subsidiary-name→FRN corroboration is matched against THIS SAME call's `form499Rows` (their
	 * `legalNameOfCarrier`) — an `edgarRows` source with no accompanying `form499Rows` still writes every disclosure
	 * edge, just with no corroborating FRN link possible.
	 */
	edgarRows?: AsyncIterable<EdgarSubsidiaryRow> | Iterable<EdgarSubsidiaryRow>
	/**
	 * Form 499 filer TSV path — read via {@linkcode parseForm499}. Ignored when `form499Rows` is given.
	 */
	form499Path?: string
	/**
	 * BDC provider-list CSV path — read via {@linkcode parseProviderList}. Ignored when `providerRows` is given.
	 */
	providerListPath?: string
	/**
	 * Output `filer.db` path. Built at `${out}.building` and moved into place last — see the module docstring.
	 */
	out: string
	/**
	 * The build's overall vintage — becomes the manifest's `version` AND `source_vintage` (filer.db has no independent
	 * versioning yet, same deferral `build-bdc.ts` makes for `bdc.db`'s `release`), AND the `source_vintage` (only — see
	 * {@link BuildFilerOptions.validFrom} for `valid_from`) for every provider-list-derived edge (decision 7 — the
	 * provider list carries no per-row date of its own). A free-text human vintage LABEL (`"2026-Q2"`) is fine here —
	 * this field is never written into a temporal (`valid_from`/`valid_to`) column, so it carries no ISO-shape
	 * requirement of its own.
	 *
	 * SNAPSHOT semantics (see the module docstring's MINOR-B note): calling {@linkcode buildFilerDatabase} again against
	 * the SAME `out` with a DIFFERENT `sourceVintage` REPLACES the artifact — it does not accumulate the earlier
	 * vintage's rows alongside the new ones. There is no options-level way to build a multi-vintage archive in one
	 * artifact; that would require rows spanning multiple vintages passed into a SINGLE call.
	 */
	sourceVintage: string
	/**
	 * ISO `YYYY-MM-DD` date for `valid_from` on every provider-list-derived edge — deliberately a SEPARATE field from
	 * {@link BuildFilerOptions.sourceVintage}, never derived from it. The provider list carries no per-row date, which
	 * makes the whole-file `sourceVintage` the tempting single source for BOTH `source_vintage` and `valid_from` — but
	 * `sourceVintage` is a free-text human vintage label (e.g. `"2026-Q2"`), not guaranteed ISO-sortable, while
	 * `valid_from` participates in every downstream `asOf`-scoped predicate (`filer-lookup.ts`'s `valid_from <= asOf`) as
	 * a plain STRING comparison. `"2026-Q2"` sorts lexicographically ABOVE any ISO date in its own year (`"Q"` outranks
	 * every digit at the first position where the two differ) — writing it into `valid_from` silently breaks every
	 * `asOf`-scoped read against that edge (reviewer probe: a fully populated filer.db built with `sourceVintage:
	 * "2026-Q2"` returned `identifiers: []` from `filerLookup`). Validated via {@linkcode assertISODate}. REQUIRED when
	 * `providerRows`/`providerListPath` is supplied (thrown otherwise); ignored when no provider-list source is given.
	 * Deliberately NOT derived automatically from `sourceVintage` when omitted — guessing a specific date from an
	 * arbitrary label (which day inside "Q2"?) would be a fabrication this builder refuses to make; the caller, who knows
	 * the file's actual publish/effective date, supplies it explicitly.
	 */
	validFrom?: string
	/**
	 * `git rev-parse --short HEAD` — passed in by the command, not read from the repo here.
	 */
	buildSHA: string
	onProgress?: (message: string) => void
}

export interface BuildFilerResult {
	out: string
	/**
	 * Distinct `filer_node` rows after the build (PK-deduped — a node minted by multiple rows counts once).
	 */
	nodes: number
	/**
	 * Distinct `filer_edge` rows after the build (PK-deduped on `(from_node_id, to_node_id, source, valid_from)` — the
	 * SAME assertion re-inserted, e.g. by a repeated source row, counts once).
	 */
	edges: number
	/**
	 * Distinct `filer_attribute` rows after the build (staging-table-deduped on `(node_id, key, value, source,
	 * source_vintage)` — see the module docstring for why `value` is part of that key).
	 */
	attributes: number
	/**
	 * Distinct `filer_family` rows after the build — PK-deduped on `(node_id, family_id, naming_node_id, source,
	 * valid_from)`, the identical composite shape as `filer_edge`'s own PK plus the naming provenance. One row per
	 * `HoldingCompany`/`ManagementCompany` edge whose target name canonicalized to something non-empty (see
	 * {@linkcode mintFamilyID}), so two DIFFERENT spellings of one family under one source at one instant count as two
	 * rows here, not one.
	 */
	families: number
	/**
	 * Count of edge OPPORTUNITIES declined because a legitimately-optional source field was empty/null — NOT an error
	 * condition, and NOT deduped (every occurrence counts, even if two rows independently miss the same field): a 499 row
	 * with `frn: null` (+1 — none of that row's three FRN-anchored edges can be minted), a 499 row with `frn` present but
	 * an empty `holdingCompany` (+1) or `managementCompany` (+1), and a provider-list row with `holdingCompany: null`
	 * (+1).
	 */
	skipped: number
	/**
	 * `filer_edge` rows whose `valid_to` was closed from a Form 499 cessation note — see `closeableCessationDate`
	 * (`build/form499-rows.ts`) for which ones qualify.
	 */
	closedByCessation: number
	/**
	 * Cessation dates that could NOT close a window because doing so would produce an inverted or empty one, i.e.
	 * `ceasedAt <= lastFiledAt` — 1,440 of the 3,261 ceased filers naming a holding or management company in the
	 * 2025-12-07 vintage. The date is still recorded as a `ceased_at` attribute; only the temporal window abstains.
	 *
	 * NOT an error. See `closeableCessationDate` (`build/form499-rows.ts`) for why these two dates disagree so often.
	 */
	cessationWindowAbstained: number
	/**
	 * `SupersededBy` edges written from `Replaced by filer <id>` notes.
	 */
	supersessions: number
}

/**
 * Build `filer.db`: create tables → stage+materialize `filer_attribute` (dedup) → direct PK-deduped `INSERT OR IGNORE`
 * into `filer_node`/`filer_edge` → index-after-load → manifest → seal → atomic move-into-place. See the module
 * docstring for the full flow rationale and the edges/attributes emitted.
 */
export async function buildFilerDatabase(options: BuildFilerOptions): Promise<BuildFilerResult> {
	const progress = options.onProgress ?? (() => {})

	const hasForm499Source = Boolean(options.form499Rows ?? options.form499Path)
	const hasProviderSource = Boolean(options.providerRows ?? options.providerListPath)
	const hasEdgarSource = Boolean(options.edgarRows)

	if (!hasForm499Source && !hasProviderSource && !hasEdgarSource) {
		throw new Error(
			"buildFilerDatabase: pass at least one of form499Rows/form499Path, providerRows/providerListPath, or edgarRows"
		)
	}

	// Options-level guard, fails fast (before any file/DB I/O) — see assertProviderValidFrom's docstring. `null` when
	// no provider-list source was supplied: the provider-row loop below never runs in that case, so validFrom is never
	// read.
	const providerValidFrom = hasProviderSource ? assertProviderValidFrom(options.validFrom) : null

	const buildingPath = `${options.out}.building`

	if (existsSync(buildingPath)) {
		rmSync(buildingPath)
	}

	mkdirSync(dirname(options.out), { recursive: true })

	const form499Source: AsyncIterable<Form499Row> | Iterable<Form499Row> =
		options.form499Rows ?? (options.form499Path ? parseForm499(options.form499Path) : [])

	const providerSource: AsyncIterable<ProviderListRow> | Iterable<ProviderListRow> =
		options.providerRows ?? (options.providerListPath ? parseProviderList(options.providerListPath) : [])

	const edgarSource: AsyncIterable<EdgarSubsidiaryRow> | Iterable<EdgarSubsidiaryRow> = options.edgarRows ?? []

	const db = new DatabaseSync(buildingPath)
	// Build-tuning pragmas — identical to build-bdc.ts's discipline.
	db.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")
	const kdb = new DatabaseClient<FilerDatabase>(db)

	progress("creating manifest/node/edge/attribute/cluster/family/attribute-stage tables")
	await createFilerBuildTables(kdb)

	const insNode = db.prepare(
		`INSERT OR IGNORE INTO filer_node (node_id, identifier_type, identifier_value) VALUES (?, ?, ?)`
	)

	// relationship: FRN<->form499ID and bdcProviderID<->FRN assert identity (SameEntity); the
	// holding-/management-company edges below assert HoldingCompany/ManagementCompany — see the module docstring's
	// "relationship is fully typed" section.
	const insEdge = db.prepare(
		`INSERT OR IGNORE INTO filer_edge (
			from_node_id, to_node_id, assertion, relationship, source, source_vintage, valid_from, valid_to, match_score, evidence
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)

	// filer_family — same "no staging table needed" discipline as filer_node/filer_edge above (module
	// docstring): the composite PK (node_id, family_id, naming_node_id, source, valid_from) already provides the
	// uniqueness a staging table would otherwise exist to give. naming_node_id belongs in that key —
	// see createFilerFamilyTable's docstring for why leaving it out would make THIS statement's OR IGNORE drop a
	// second, differently-spelled report of the same family.
	const insFamily = db.prepare(
		`INSERT OR IGNORE INTO filer_family (
			node_id, family_id, naming_node_id, assertion, relationship, source, source_vintage, valid_from, valid_to, match_score
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)

	const insAttrStage = db.prepare(
		`INSERT OR IGNORE INTO filer_attribute_stage (node_id, key, value, source, source_vintage) VALUES (?, ?, ?, ?, ?)`
	)

	let skipped = 0
	let batch = 0

	function commitBatch(): void {
		batch++

		if (batch >= STAGE_BATCH_SIZE) {
			db.exec("COMMIT")
			db.exec("BEGIN")
			batch = 0
		}
	}

	function stageAttribute(nodeID: string, key: string, value: string, source: string, sourceVintage: string): void {
		if (!value) return

		insAttrStage.run(nodeID, key, value, source, sourceVintage)
	}

	progress("staging nodes/edges/attributes — raw prepared INSERT OR IGNORE")
	db.exec("BEGIN")

	// EDGAR corroboration input — keyed by FRN, keeping the LATEST lastFiledAt's legal name per FRN, the
	// same "latest wins" convention cluster-filers.ts's readLatestLegalNames uses for the identical reason (a
	// re-filing under a new legal name is real). Built here (in-memory, from the SAME form499Source this call
	// already iterates) rather than by re-querying the DB, since the edgar loop runs later in this same function —
	// see the module docstring's "EDGAR Exhibit 21 ingest" section.
	const legalNameByFRN = new Map<string, { name: string; filedAt: string }>()

	let form499RowIndex = 0
	const lifecycleTotals: Form499LifecycleTotals = { closed: 0, abstained: 0, supersessions: 0 }

	for await (const row of form499Source) {
		form499RowIndex++

		const form499NodeID = mintForm499NodeID(row.form499ID, form499RowIndex)
		insNode.run(form499NodeID, FilerIdentifierType.Form499ID, row.form499ID)

		// Guarded ONCE per row, before anything below writes it into source_vintage/valid_from — see the
		// docstring above assertLastFiledAt. ISO-validated too: this SAME value becomes valid_from on every edge this row emits, and valid_from must
		// always be ISO-sortable — see assertISODate's docstring.
		const lastFiledAt = assertISODate(
			assertLastFiledAt(row.lastFiledAt, row.form499ID, form499RowIndex),
			`form499 row #${form499RowIndex} (form499ID=${JSON.stringify(row.form499ID)}) lastFiledAt`
		)

		// Attributes attach to the form499ID node — the only identifier guaranteed present on every row
		// (frn can legitimately be null). See the module docstring's DC-agent doctrine: dcAgent* fields land
		// here as plain attributes ONLY, never as edges.
		stageAttribute(form499NodeID, "legal_name", row.legalNameOfCarrier, "form-499", lastFiledAt)
		stageAttribute(form499NodeID, "dba", row.doingBusinessAs, "form-499", lastFiledAt)

		for (const classification of classifyFiler(row)) {
			stageAttribute(form499NodeID, "classification", classification, "form-499", lastFiledAt)
		}

		stageAttribute(form499NodeID, "hq_address", row.hqAddress, "form-499", lastFiledAt)

		stageAttribute(
			form499NodeID,
			"customer_inquiries_telephone",
			row.customerInquiriesTelephone,
			"form-499",
			lastFiledAt
		)

		stageAttribute(form499NodeID, "customer_inquiries_address", row.customerInquiriesAddress, "form-499", lastFiledAt)

		stageAttribute(form499NodeID, "dc_agent_display_name", row.dcAgentDisplayName, "form-499", lastFiledAt)

		stageAttribute(form499NodeID, "dc_agent_organization_name", row.dcAgentOrganizationName, "form-499", lastFiledAt)

		stageAttribute(form499NodeID, "dc_agent_telephone", row.dcAgentTelephone, "form-499", lastFiledAt)
		stageAttribute(form499NodeID, "dc_agent_email_address", row.dcAgentEmailAddress, "form-499", lastFiledAt)
		stageAttribute(form499NodeID, "dc_agent_address", row.dcAgentAddress, "form-499", lastFiledAt)

		// The FCC's own lifecycle notes, when the source carried them (workbook only — the 17-column TSV has
		// no note columns, so `lifecycle` is undefined there and this is a no-op).
		const relationshipValidTo = processForm499Lifecycle(insNode, insEdge, stageAttribute, lifecycleTotals, {
			lifecycle: row.lifecycle,
			form499NodeID,
			lastFiledAt,
		})

		if (row.frn) {
			skipped += processForm499FRNRelationships(insNode, insEdge, insFamily, legalNameByFRN, {
				row,
				frn: row.frn,
				form499NodeID,
				form499RowIndex,
				lastFiledAt,
				relationshipValidTo,
			})
		} else {
			// No FRN on this row at all — legitimate (decision 3: not yet registered in CORES), not malformed.
			// None of the three FRN-anchored edges above can be minted for this row.
			skipped++
		}

		commitBatch()
	}

	let providerRowIndex = 0

	for await (const row of providerSource) {
		providerRowIndex++

		const providerNodeID = mintProviderNodeID(row.providerID, providerRowIndex)
		insNode.run(providerNodeID, FilerIdentifierType.BDCProviderID, String(row.providerID))

		const frnNodeID = mintFRNNodeID(row.frn, `provider-list row #${providerRowIndex} (providerID=${row.providerID})`)
		insNode.run(frnNodeID, FilerIdentifierType.FRN, row.frn)

		// source_vintage stays the (possibly non-ISO) human vintage label; valid_from is the SEPARATE, always-ISO
		// providerValidFrom — see BuildFilerOptions.validFrom's docstring. Non-null
		// here by construction: this loop only runs when hasProviderSource is true, the same condition that made
		// providerValidFrom non-null above.
		insEdge.run(
			providerNodeID,
			frnNodeID,
			FilerEdgeAssertion.Authoritative,
			FilerRelationship.SameEntity,
			"bdc-provider-list",
			options.sourceVintage,
			providerValidFrom!,
			null,
			null,
			null
		)

		if (row.holdingCompany) {
			const holdingNodeID = mintHoldingCompanyNodeID(row.holdingCompany)
			insNode.run(holdingNodeID, FilerIdentifierType.HoldingCompanyName, row.holdingCompany)

			insEdge.run(
				providerNodeID,
				holdingNodeID,
				FilerEdgeAssertion.Authoritative,
				FilerRelationship.HoldingCompany,
				"bdc-provider-list",
				options.sourceVintage,
				providerValidFrom!,
				null,
				null,
				null
			)

			insertFamilyMembership(insFamily, {
				memberNodeID: providerNodeID,
				namingNodeID: holdingNodeID,
				identifierType: FilerIdentifierType.HoldingCompanyName,
				name: row.holdingCompany,
				relationship: FilerRelationship.HoldingCompany,
				assertion: FilerEdgeAssertion.Authoritative,
				matchScore: null,
				source: "bdc-provider-list",
				sourceVintage: options.sourceVintage,
				validFrom: providerValidFrom!,
			})
		} else {
			skipped++
		}

		commitBatch()
	}

	// EDGAR Exhibit 21 ingest — see the module docstring's own section for the full rationale, and
	// processEdgarSubsidiaryRow's docstring (build/edgar-rows.ts) for the per-row edge/family logic. The
	// bucket map is built from THIS call's own form499 rows, so it must be grouped after that loop has run.
	const frnsByCanonicalLegalName = groupFRNsByCanonicalLegalName(legalNameByFRN)

	let edgarRowIndex = 0

	for await (const row of edgarSource) {
		edgarRowIndex++
		processEdgarSubsidiaryRow(insNode, insEdge, insFamily, frnsByCanonicalLegalName, row, edgarRowIndex)
		commitBatch()
	}

	db.exec("COMMIT")

	const stagedCountRow = db.prepare("SELECT COUNT(*) AS staged_count FROM filer_attribute_stage").get() as {
		staged_count: number
	}

	progress(`staged ${stagedCountRow.staged_count.toLocaleString()} distinct attribute fact(s)`)

	progress("materializing filer_attribute from the staged, deduped facts")

	db.exec(
		`INSERT INTO filer_attribute (node_id, key, value, source, source_vintage)
		 SELECT node_id, key, value, source, source_vintage FROM filer_attribute_stage`
	)

	await kdb.schema.dropTable("filer_attribute_stage").execute()

	progress("index-after-load")
	await createFilerEdgeToNodeIndex(kdb)
	await createFilerAttributeNodeIndex(kdb)
	await createFilerClusterIndex(kdb)
	await createFilerFamilyIndex(kdb)

	const sourcesUsed: string[] = []

	if (hasForm499Source) {
		sourcesUsed.push("form-499")
	}

	if (hasProviderSource) {
		sourcesUsed.push("bdc-provider-list")
	}

	if (hasEdgarSource) {
		sourcesUsed.push("edgar-exhibit-21")
	}

	progress("writing filer_manifest")

	await kdb
		.insertInto("filer_manifest")
		.values({
			name: "filer",
			// filer.db has no independent versioning yet — same deferral build-bdc.ts makes for bdc.db's `release`.
			version: options.sourceVintage,
			// The current schema version from filer/schema.ts — bumped to 3 when SupersededBy and
			// valid_to semantics landed. Every reader that needs temporal awareness should gate on this.
			schema_version: FILER_SCHEMA_VERSION,
			source: sourcesUsed.join(","),
			source_vintage: options.sourceVintage,
			// No `mailwoman filer build` CLI exists (filer.db has no CLI wiring in 3a — see the module docstring's
			// decision-2 note) — name the actual API entrypoint that produced this artifact instead of a command
			// that isn't there.
			build_cmd: "buildFilerDatabase (@mailwoman/filer/sdk)",
			build_sha: options.buildSHA,
			created_at: new Date().toISOString(),
		})
		.execute()

	const nodeCount = (db.prepare("SELECT COUNT(*) AS c FROM filer_node").get() as { c: number }).c
	const edgeCount = (db.prepare("SELECT COUNT(*) AS c FROM filer_edge").get() as { c: number }).c
	const attributeCount = (db.prepare("SELECT COUNT(*) AS c FROM filer_attribute").get() as { c: number }).c
	const familyCount = (db.prepare("SELECT COUNT(*) AS c FROM filer_family").get() as { c: number }).c

	progress(
		`materialized ${nodeCount.toLocaleString()} node(s), ${edgeCount.toLocaleString()} edge(s), ` +
			`${attributeCount.toLocaleString()} attribute(s), ${familyCount.toLocaleString()} family membership(s) ` +
			`(${skipped.toLocaleString()} edge opportunity/ies skipped)`
	)

	progress("finalize: ANALYZE + VACUUM")
	db.exec("ANALYZE")
	// page_size MUST be set right before VACUUM — node:sqlite initializes the file at the 4096 default on
	// `new DatabaseSync`, so the earlier pragma is a no-op until a VACUUM rebuilds at the new size (matches
	// build-bdc.ts's same discipline).
	db.exec("PRAGMA page_size=8192")
	db.exec("VACUUM")
	await kdb.destroy()

	progress("seal")
	sealDatabase(buildingPath)

	// Atomic move-into-place — the previous version is moved ASIDE FIRST, per the AGENTS.md database house
	// rule and build-bdc.ts's identical `${out}.prev` swap.
	if (existsSync(options.out)) {
		renameSync(options.out, `${options.out}.prev`)
	}

	renameSync(buildingPath, options.out)

	if (existsSync(`${options.out}.prev`)) {
		rmSync(`${options.out}.prev`)
	}

	return {
		out: options.out,
		nodes: nodeCount,
		edges: edgeCount,
		attributes: attributeCount,
		families: familyCount,
		skipped,
		closedByCessation: lifecycleTotals.closed,
		cessationWindowAbstained: lifecycleTotals.abstained,
		supersessions: lifecycleTotals.supersessions,
	}
}
