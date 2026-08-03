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
 *   `createFilerFamilyTable`'s PK docstring in `schema.ts` for why that placement is load-bearing) already
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
 *   The direction convention (documented, not semantically load-bearing — `filer_edge` asserts symmetric
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
 *      wrong company; that edge scores 0.5. See {@linkcode scoreEdgarSubsidiaryMatch} for the three-rung
 *      ladder and its ceiling.
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
 */

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { sealDatabase } from "@mailwoman/core/utils"
import { canonicalizeOrganizationName } from "@mailwoman/record"
import type { Kysely } from "kysely"

import {
	createFilerAttributeNodeIndex,
	createFilerAttributeTable,
	createFilerClusterIndex,
	createFilerClusterTable,
	createFilerEdgeTable,
	createFilerEdgeToNodeIndex,
	createFilerFamilyIndex,
	createFilerFamilyTable,
	createFilerManifestTable,
	createFilerNodeTable,
	FilerEdgeAssertion,
	FilerIdentifierType,
	FilerRelationship,
	type FilerDatabase,
} from "../schema.ts"
import { mintFamilyID } from "./family-id.ts"
import { classifyFiler, parseForm499, type Form499Row } from "./form499.ts"
import { assertISODate } from "./guards.ts"
import { parseProviderList, type ProviderListRow } from "./provider-list.ts"

/**
 * Rows committed per `BEGIN`/`COMMIT` batch — matches `build-bdc.ts`'s `STAGE_BATCH_SIZE` discipline. Counted per
 * SOURCE ROW processed (a single 499 row can trigger several node/edge/attribute-stage inserts), not per individual
 * `.run()` call.
 */
const STAGE_BATCH_SIZE = 10_000

/**
 * One EDGAR Exhibit 21 subsidiary disclosure — the shape Task 6's CIK resolution + Task 7's `parseExhibit21` produce
 * somewhere upstream of this file. See the module docstring's "EDGAR Exhibit 21 ingest" section for exactly what
 * {@linkcode buildFilerDatabase} does with one of these.
 */
export interface EdgarSubsidiaryRow {
	/**
	 * Zero-padded 10-digit CIK of the filer whose Exhibit 21 disclosed this subsidiary — the PARENT. Validated the same
	 * zero-padded 10-digit shape `edgar-filings.ts`'s `CIK` branded type requires; a malformed value throws (decision 8's
	 * "malformed input is loud" discipline).
	 */
	cik: string
	/**
	 * The subsidiary's name exactly as Exhibit 21 spelled it — never normalized before minting its node (mirrors
	 * `mintHoldingCompanyNodeID`'s identical "raw string" precedent).
	 */
	subsidiaryName: string
	/**
	 * Jurisdiction of incorporation, when Exhibit 21 gave one ({@linkcode parseExhibit21}'s own `unparseable` abstention
	 * already dropped any row this couldn't confidently extract — this field is carried through for provenance/audit
	 * only; nothing in this builder currently writes it to a column).
	 */
	jurisdiction?: string
	/**
	 * ISO `YYYY-MM-DD` filing date of the 10-K this Exhibit 21 came from — becomes BOTH `source_vintage` and `valid_from`
	 * on every edge/family row this row produces (decision 7 — a single per-row date, the same shape
	 * `Form499Row.lastFiledAt` uses). Validated via {@linkcode assertISODate}.
	 */
	filingDate: string
}

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
	 * ISO `YYYY-MM-DD` date for `valid_from` on every provider-list-derived edge (review fix, round N) — deliberately a
	 * SEPARATE field from {@link BuildFilerOptions.sourceVintage}, never derived from it. The provider list carries no
	 * per-row date, so decision 7 originally used the whole-file `sourceVintage` for BOTH `source_vintage` and
	 * `valid_from` — but `sourceVintage` is a free-text human vintage label (e.g. `"2026-Q2"`), not guaranteed
	 * ISO-sortable, while `valid_from` participates in every downstream `asOf`-scoped predicate (`filer-lookup.ts`'s
	 * `valid_from <= asOf`) as a plain STRING comparison. `"2026-Q2"` sorts lexicographically ABOVE any real ISO date
	 * this century (`"Q"` > any ASCII digit) — writing it into `valid_from` silently breaks every `asOf`-scoped read
	 * against that edge (reviewer probe: a fully populated filer.db built with `sourceVintage: "2026-Q2"` returned
	 * `identifiers: []` from `filerLookup`). Validated via {@linkcode assertISODate}. REQUIRED when
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
	 * valid_from)`, the identical composite shape as `filer_edge`'s own PK plus the naming provenance (task 3 fix round
	 * 4). One row per `HoldingCompany`/`ManagementCompany` edge whose target name canonicalized to something non-empty
	 * (see {@linkcode mintFamilyID}), so two DIFFERENT spellings of one family under one source at one instant count as
	 * two rows here, not one.
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
}

/**
 * Create the build-only `filer_attribute_stage` table — see the module docstring for why `value` is part of the
 * composite PK. Deliberately NOT part of the public {@link FilerDatabase} interface, mirroring `build-bdc.ts`'s
 * `bdc_stage` (dropped before the artifact seals). All reads/writes against it below go through raw `.prepare()` on the
 * shared `DatabaseSync`, per the "hot bulk write" carve-out.
 */
async function createFilerAttributeStageTable(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema
		.createTable("filer_attribute_stage")
		.addColumn("node_id", "text", (c) => c.notNull())
		.addColumn("key", "text", (c) => c.notNull())
		.addColumn("value", "text", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("source_vintage", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("filer_attribute_stage_pk", ["node_id", "key", "value", "source", "source_vintage"])
		.execute()
}

/**
 * Mints the `frn:` node id, throwing when `frn` is blank — the same "malformed input is loud" discipline as
 * {@linkcode mintForm499NodeID}/{@linkcode mintProviderNodeID}.
 *
 * On the 499 path this is called only from inside the caller's `if (row.frn)` truthy check — an empty string is falsy
 * in JS, so that branch is already skipped before this function is ever reached there; the guard is unreachable on that
 * path, not merely redundant. On the provider-list path `ProviderListRow.frn` is typed as always-present (`FRN`, never
 * `FRN | null`), and {@linkcode parseProviderList} validates it via `toFRN` on the production (file-reading) route — but
 * the `providerRows` TEST SEAM bypasses that parser entirely. Without this guard, two rows for two DIFFERENT, unrelated
 * providers each carrying a blank `frn` would silently mint and share ONE degenerate `frn:` node — a false identity
 * link joining unrelated filers, the worst failure class this crosswalk can produce (review finding).
 */
function mintFRNNodeID(frn: string, context: string): string {
	if (frn.trim() === "") {
		throw new Error(
			`buildFilerDatabase: malformed ${context} — empty frn. Refusing to mint a degenerate node_id ("frn:") ` +
				`that every other empty-frn row would silently collapse into, falsely joining unrelated filers under one identity.`
		)
	}

	return `${FilerIdentifierType.FRN}:${frn}`
}

function mintHoldingCompanyNodeID(name: string): string {
	return `${FilerIdentifierType.HoldingCompanyName}:${name}`
}

function mintManagementCompanyNodeID(name: string): string {
	return `${FilerIdentifierType.ManagementCompanyName}:${name}`
}

const CIK_SHAPE_PATTERN = /^\d{10}$/

/**
 * Mints the `cik:` node id, throwing when `cik` isn't the zero-padded 10-digit shape `edgar-filings.ts`'s `CIK` branded
 * type requires — the same "malformed input is loud" discipline as {@linkcode mintFRNNodeID}: a malformed CIK would
 * otherwise mint a degenerate/inconsistent node id that could collide with an unrelated row's.
 */
function mintCIKNodeID(cik: string, context: string): string {
	if (!CIK_SHAPE_PATTERN.test(cik)) {
		throw new Error(
			`buildFilerDatabase: malformed ${context} — cik must be a zero-padded 10-digit string, got ${JSON.stringify(cik)}`
		)
	}

	return `${FilerIdentifierType.CIK}:${cik}`
}

/**
 * Mints the `subsidiary_name:` node id for a raw Exhibit 21 disclosure — the same "global name-node" shape
 * {@linkcode mintHoldingCompanyNodeID} uses (the raw string, unnormalized; two different parents both disclosing a
 * subsidiary under the identical spelling share one node).
 */
function mintSubsidiaryNameNodeID(name: string): string {
	return `${FilerIdentifierType.SubsidiaryName}:${name}`
}

/**
 * The subsidiary-name→FRN score when the two RAW names are BYTE-IDENTICAL — the strongest this match can ever be, and
 * the CEILING for {@linkcode scoreEdgarSubsidiaryMatch}.
 *
 * **It is not 1, and it is bounded by what canonical-name matching can know, which is less than identity.** Two
 * disjoint companies can file under the same legal name; `edgar-filings.ts`'s `resolveCIKCandidates` docstring pins
 * that case verbatim (`"American Broadband LLC"` and `"American Broadband, Inc."`, disjoint CIKs) and says in terms
 * that "a score of `1` is not itself a license to pick". A name is evidence about identity, never a proof of it, so no
 * value on this ladder may read as certainty.
 */
const EDGAR_MATCH_SCORE_IDENTICAL_RAW_NAME = 0.9

/**
 * The score when the two raw names differ only in what canonicalization normalizes WITHOUT deleting — case,
 * punctuation, accents, `&`/`and`, a leading `The`, whitespace — while carrying the SAME legal designations (`"ACME
 * FIBER, LLC"` vs `"Acme Fiber LLC"`). Real formatting variance between two filings of one company's name, so
 * meaningfully weaker than a byte-identical match but not the ambiguous case below.
 */
const EDGAR_MATCH_SCORE_NORMALIZATION_ONLY = 0.75

/**
 * The score when the two raw names differ in their LEGAL DESIGNATIONS — `"American Broadband LLC"` (499) vs `"American
 * Broadband, Inc."` (Exhibit 21). Weak on purpose: canonicalization is what erased the only part of the string that
 * distinguished them, so the match is resting on a token it deliberately threw away. The abstention above ({@linkcode
 * processEdgarSubsidiaryRow}'s `matchedFRNs.length !== 1`) does NOT cover this — it only fires on a collision WITHIN
 * the 499 file, so when 499 carries only the LLC and Exhibit 21 discloses the Inc., exactly one FRN matches and the
 * edge is written. That edge may well be the wrong company; this number says so.
 */
const EDGAR_MATCH_SCORE_DESIGNATION_DIFFERS = 0.5

/**
 * The sorted legal designations {@linkcode canonicalizeOrganizationName} STRIPPED from a name, as a comparable key.
 * Sorted (not encounter-ordered) because `"Acme Co Inc"` and `"Acme Inc Co"` deleted the same tokens.
 */
function strippedDesignationKey(name: string): string {
	return (canonicalizeOrganizationName(name)?.designations ?? []).toSorted().join(" ")
}

/**
 * The `match_score` for one subsidiary-name→FRN inference — replacing the flat `0.92` this builder used to write on
 * EVERY such link regardless of how much the match actually knew.
 *
 * Both names reaching this function already share a canonical form; that is the match. The question this answers is how
 * much of the ORIGINAL string that shared form threw away, because `canonicalizeOrganizationName` maps `"American
 * Broadband LLC"`, `"American Broadband, Inc."` and `"American Broadband Corp"` all to `"american broadband"`
 * (verified). A match that provably cannot tell three companies apart must not report the same confidence as one on
 * identical raw names.
 *
 * **`@mailwoman/match`'s comparators were checked first and are the wrong instrument here — measured, not assumed.**
 * `nameSimilarity` on the RAW pair scores `"American Broadband LLC"` vs `"American Broadband, Inc."` at **0.9485** and
 * vs `"American Broadband Corp"` at **0.9557** — HIGHER than the 0.92 constant being removed, because Jaro-Winkler's
 * prefix boost rewards exactly the long shared head these pairs have. String distance measures how alike two spellings
 * look; the signal that separates a real match from a designation collision is WHICH TOKENS canonicalization deleted,
 * which is a set comparison. So this uses `canonicalizeOrganizationName`'s own `designations` output — already computed
 * on this path, no new dependency — rather than a comparator that would score the ambiguous case highest of all.
 *
 * Three outcomes, no interpolation: a similarity curve here would imply a resolution this evidence does not have.
 */
function scoreEdgarSubsidiaryMatch(subsidiaryName: string, legalName: string): number {
	if (subsidiaryName === legalName) return EDGAR_MATCH_SCORE_IDENTICAL_RAW_NAME

	return strippedDesignationKey(subsidiaryName) === strippedDesignationKey(legalName)
		? EDGAR_MATCH_SCORE_NORMALIZATION_ONLY
		: EDGAR_MATCH_SCORE_DESIGNATION_DIFFERS
}

// mintFamilyID moved to family-id.ts — filer-lookup.ts's readFamilyDisplayNames now needs the
// identical canonicalization rule to tell apart which target node's edge names a given family_id, and re-deriving it
// a second time independently would be exactly the "two definitions that can drift" hazard guards.ts's own extraction
// already closed for assertISODate.

/**
 * The one `filer_family` row {@linkcode insertFamilyMembership} writes, described in the builder's own terms rather
 * than the table's: `memberNodeID`/`namingNodeID` are the two ends of the `HoldingCompany`/`ManagementCompany` edge
 * this row accompanies, and `identifierType`/`name` are what {@linkcode mintFamilyID} canonicalizes into the
 * `family_id`.
 */
interface FamilyMembershipFact {
	/**
	 * The edge's `from_node_id` — an FRN or `bdcProviderID` node. Becomes `filer_family.node_id`.
	 */
	memberNodeID: string
	/**
	 * The edge's `to_node_id` — the holding-/management-company node whose raw name produced `family_id`. Becomes
	 * `filer_family.naming_node_id`.
	 */
	namingNodeID: string
	/**
	 * One of {@link FilerIdentifierType} — the namespace `family_id` is minted under.
	 */
	identifierType: string
	/**
	 * The RAW company name, canonicalized by {@linkcode mintFamilyID}. Never written verbatim to `filer_family`; the raw
	 * spelling lives on the `filer_node` `namingNodeID` points at.
	 */
	name: string
	/**
	 * One of {@link FilerRelationship} — copied from the accompanying edge, never re-derived.
	 */
	relationship: string
	/**
	 * One of {@link FilerEdgeAssertion} — copied from the accompanying edge, never re-derived. Required rather than
	 * defaulted to `Authoritative`: a new family writer must state the strength of its claim on purpose, and a default
	 * would let an inferred one inherit authority by omission — the exact conflation gate 2 exists to prevent.
	 */
	assertion: string
	/**
	 * The inferred match's score; `null` on an authoritative membership, where nothing was matched (the schema's own
	 * CHECK constraint rejects a score there — see `createFilerFamilyTable`).
	 */
	matchScore: number | null
	source: string
	sourceVintage: string
	validFrom: string
}

/**
 * Write one `filer_family` membership row for a `HoldingCompany`/`ManagementCompany` edge's SOURCE node (the edge's own
 * `from_node_id` — an FRN or `bdcProviderID`) — see {@linkcode mintFamilyID} for how `family_id` is derived from the
 * TARGET name's canonical form. Skips silently (no row, no error, no `skipped` increment — a family row is a bonus
 * derived fact, not an edge opportunity) when the name canonicalizes to nothing. Module-level (not a closure inside
 * {@linkcode buildFilerDatabase}, unlike `stageAttribute`/`commitBatch`) purely to stay under the linter's
 * `max-statements` ceiling — `insFamily` (the prepared statement it writes through) is passed in rather than closed
 * over.
 *
 * {@link FamilyMembershipFact.namingNodeID} is the company node this row's `family_id` was minted FROM — the edge's
 * `to_node_id`, which every caller has already minted immediately above its call (task 3 fix round 4; it is
 * deliberately taken as a field rather than re-derived from `identifierType`/`name` here, so the family row and the
 * edge can never name two different nodes). Persisting it is what lets `filer-lookup.ts`'s `readFamilyDisplayNames`
 * recover the raw spelling by a plain join instead of re-running `canonicalizeOrganizationName` at read time against a
 * sealed, separately-versioned artifact — see `schema.ts`'s file header for the drift that closed. Adding it pushed
 * this function's positional arity past the linter's `max-params` ceiling, hence the single options argument.
 */
function insertFamilyMembership(insFamily: StatementSync, fact: FamilyMembershipFact): void {
	const familyID = mintFamilyID(fact.identifierType, fact.name)

	if (!familyID) return

	insFamily.run(
		fact.memberNodeID,
		familyID,
		fact.namingNodeID,
		fact.assertion,
		fact.relationship,
		fact.source,
		fact.sourceVintage,
		fact.validFrom,
		null,
		fact.matchScore
	)
}

/**
 * {@linkcode processForm499FRNRelationships}'s per-row context — bundled into one options argument (matching
 * {@linkcode FamilyMembershipFact}'s own precedent) once threading `legalNameByFRN` through pushed this function's
 * positional arity past the linter's `max-params` ceiling.
 */
interface Form499FRNContext {
	row: Form499Row
	frn: string
	form499NodeID: string
	form499RowIndex: number
	lastFiledAt: string
}

/**
 * One 499 row's FRN-anchored writes: `FRN↔form499ID` (always), `FRN↔holdingCompanyName`/`FRN↔managementCompanyName`
 * (when the corresponding field is non-empty, each its own edge + `filer_family` row) — see the module docstring's
 * "Edges emitted" section. Also records this row's legal name into `legalNameByFRN` for Task 8's EDGAR corroboration
 * match, keeping the LATEST `lastFiledAt` per FRN. Returns the number of edge OPPORTUNITIES declined (0, 1, or 2 — see
 * {@link BuildFilerResult.skipped}'s docstring), for the caller to add to its own running total. Module-level (matching
 * {@linkcode insertFamilyMembership}'s own precedent) purely to stay under the linter's `max-statements` ceiling — this
 * call site's own docstring precedes it in {@linkcode buildFilerDatabase}.
 */
function processForm499FRNRelationships(
	insNode: StatementSync,
	insEdge: StatementSync,
	insFamily: StatementSync,
	legalNameByFRN: Map<string, { name: string; filedAt: string }>,
	context: Form499FRNContext
): number {
	const { row, frn, form499NodeID, form499RowIndex, lastFiledAt } = context
	const frnContext = `form499 row #${form499RowIndex} (form499ID=${JSON.stringify(row.form499ID)})`
	const frnNodeID = mintFRNNodeID(frn, frnContext)
	insNode.run(frnNodeID, FilerIdentifierType.FRN, frn)

	if (row.legalNameOfCarrier) {
		const current = legalNameByFRN.get(frn)

		if (!current || lastFiledAt > current.filedAt) {
			legalNameByFRN.set(frn, { name: row.legalNameOfCarrier, filedAt: lastFiledAt })
		}
	}

	insEdge.run(
		frnNodeID,
		form499NodeID,
		FilerEdgeAssertion.Authoritative,
		FilerRelationship.SameEntity,
		"form-499",
		lastFiledAt,
		lastFiledAt,
		null,
		null,
		null
	)

	let skipped = 0

	if (row.holdingCompany) {
		const holdingNodeID = mintHoldingCompanyNodeID(row.holdingCompany)
		insNode.run(holdingNodeID, FilerIdentifierType.HoldingCompanyName, row.holdingCompany)

		insEdge.run(
			frnNodeID,
			holdingNodeID,
			FilerEdgeAssertion.Authoritative,
			FilerRelationship.HoldingCompany,
			"form-499",
			lastFiledAt,
			lastFiledAt,
			null,
			null,
			null
		)

		insertFamilyMembership(insFamily, {
			memberNodeID: frnNodeID,
			namingNodeID: holdingNodeID,
			identifierType: FilerIdentifierType.HoldingCompanyName,
			name: row.holdingCompany,
			relationship: FilerRelationship.HoldingCompany,
			assertion: FilerEdgeAssertion.Authoritative,
			matchScore: null,
			source: "form-499",
			sourceVintage: lastFiledAt,
			validFrom: lastFiledAt,
		})
	} else {
		skipped++
	}

	if (row.managementCompany) {
		const managementNodeID = mintManagementCompanyNodeID(row.managementCompany)
		insNode.run(managementNodeID, FilerIdentifierType.ManagementCompanyName, row.managementCompany)

		insEdge.run(
			frnNodeID,
			managementNodeID,
			FilerEdgeAssertion.Authoritative,
			FilerRelationship.ManagementCompany,
			"form-499",
			lastFiledAt,
			lastFiledAt,
			null,
			null,
			null
		)

		insertFamilyMembership(insFamily, {
			memberNodeID: frnNodeID,
			namingNodeID: managementNodeID,
			identifierType: FilerIdentifierType.ManagementCompanyName,
			name: row.managementCompany,
			relationship: FilerRelationship.ManagementCompany,
			assertion: FilerEdgeAssertion.Authoritative,
			matchScore: null,
			source: "form-499",
			sourceVintage: lastFiledAt,
			validFrom: lastFiledAt,
		})
	} else {
		skipped++
	}

	return skipped
}

/**
 * One FRN in a canonical-name bucket, carrying the RAW `legalNameOfCarrier` spelling that landed it there (3b Task 8
 * fix round 1). The raw name is what {@linkcode scoreEdgarSubsidiaryMatch} needs: the canonical form is by definition
 * identical across every member of a bucket, so it holds none of the signal that separates a real match from a
 * designation collision.
 */
interface CanonicalNameCandidate {
	frn: string
	legalName: string
}

/**
 * Groups `legalNameByFRN` (the in-memory map {@linkcode buildFilerDatabase}'s form499 loop builds) by CANONICAL name —
 * "which FRNs share this exact canonical legal name" — the input {@linkcode processEdgarSubsidiaryRow}'s corroboration
 * match reads. A canonical name shared by two or more distinct FRNs is a genuine collision (the same
 * false-identity-link hazard `edgar-filings.ts`'s `resolveCIKCandidates` documents), so the caller must see the FULL
 * bucket rather than just "the first match" — abstaining on a multi-member bucket is `processEdgarSubsidiaryRow`'s job,
 * not this function's.
 */
function groupFRNsByCanonicalLegalName(
	legalNameByFRN: ReadonlyMap<string, { name: string; filedAt: string }>
): Map<string, CanonicalNameCandidate[]> {
	const buckets = new Map<string, CanonicalNameCandidate[]>()

	for (const [frn, { name }] of legalNameByFRN) {
		const canonical = canonicalizeOrganizationName(name)?.canonical

		if (!canonical) continue

		const candidate: CanonicalNameCandidate = { frn, legalName: name }
		const bucket = buckets.get(canonical)

		if (bucket) {
			bucket.push(candidate)
		} else {
			buckets.set(canonical, [candidate])
		}
	}

	return buckets
}

/**
 * One EDGAR subsidiary row's full write: the disclosure edge (always, authoritative) plus — only when the subsidiary
 * name canonically matches EXACTLY ONE FRN's legal name — the corroboration edge and its accompanying `filer_family`
 * row (inference, never authority; see the module docstring's "EDGAR Exhibit 21 ingest" section for the full rationale
 * and the Task 8 precondition this is written to satisfy). Module-level (not a closure inside
 * {@linkcode buildFilerDatabase}, matching {@linkcode insertFamilyMembership}'s own precedent) purely to stay under the
 * linter's `max-statements` ceiling.
 */
function processEdgarSubsidiaryRow(
	insNode: StatementSync,
	insEdge: StatementSync,
	insFamily: StatementSync,
	frnsByCanonicalLegalName: ReadonlyMap<string, CanonicalNameCandidate[]>,
	row: EdgarSubsidiaryRow,
	rowIndex: number
): void {
	const context = `edgar row #${rowIndex} (cik=${JSON.stringify(row.cik)})`
	const cikNodeID = mintCIKNodeID(row.cik, context)
	insNode.run(cikNodeID, FilerIdentifierType.CIK, row.cik)

	if (row.subsidiaryName.trim() === "") {
		throw new Error(
			`buildFilerDatabase: malformed ${context} — empty subsidiaryName. Refusing to mint a degenerate node_id ` +
				`("subsidiary_name:") that every other empty-name row would silently collapse into.`
		)
	}

	const filingDate = assertISODate(row.filingDate, `${context} filingDate`)
	const subsidiaryNodeID = mintSubsidiaryNameNodeID(row.subsidiaryName)
	insNode.run(subsidiaryNodeID, FilerIdentifierType.SubsidiaryName, row.subsidiaryName)

	// The disclosure edge — ALWAYS written, ALWAYS authoritative. See the module docstring.
	insEdge.run(
		cikNodeID,
		subsidiaryNodeID,
		FilerEdgeAssertion.Authoritative,
		FilerRelationship.Subsidiary,
		"edgar-exhibit-21",
		filingDate,
		filingDate,
		null,
		null,
		null
	)

	const canonicalSubsidiaryName = canonicalizeOrganizationName(row.subsidiaryName)?.canonical
	const matchedFRNs = canonicalSubsidiaryName ? (frnsByCanonicalLegalName.get(canonicalSubsidiaryName) ?? []) : []

	// Corroboration — INFERENCE, not authority, and only when UNAMBIGUOUS (exactly one match). Zero matches: nothing
	// more to write, the disclosure edge above is the whole fact. Two or more: a genuine name collision across
	// distinct FRNs — abstain rather than guess which one, same as resolveCIKCandidates never silently narrowing a
	// tie. KEPT as-is by task 8 fix round 1: scoring the survivors honestly is not a substitute for abstaining on a
	// tie, and the two answer different questions (WHETHER to write an edge vs how far to trust the one written).
	if (matchedFRNs.length !== 1) return

	const matched = matchedFRNs[0]!
	const matchedFRNNodeID = mintFRNNodeID(matched.frn, context)
	insNode.run(matchedFRNNodeID, FilerIdentifierType.FRN, matched.frn)

	// the score reflects what THIS match actually knows, not a flat 0.92 on every link — see
	// scoreEdgarSubsidiaryMatch. `evidence` carries both raw spellings now, so a reader can see for itself what the
	// score is grading rather than having to take the number on faith.
	const matchScore = scoreEdgarSubsidiaryMatch(row.subsidiaryName, matched.legalName)

	insEdge.run(
		matchedFRNNodeID,
		cikNodeID,
		FilerEdgeAssertion.Inferred,
		FilerRelationship.ParentCompany,
		"edgar-exhibit-21",
		filingDate,
		filingDate,
		null,
		matchScore,
		JSON.stringify({ subsidiaryName: row.subsidiaryName, legalNameOfCarrier: matched.legalName, cik: row.cik })
	)

	// The Task 8 precondition: a filer_edge row ALONE is invisible to familyRollup/filerLookup.families — both
	// answer membership from filer_family alone. family_id/naming_node_id are the CIK's OWN node id: a CIK needs no
	// mintFamilyID canonicalization to be a stable family key, unlike a free-text holding-/management-company name.
	//
	// assertion/match_score carry the SAME values as the edge above, for the same reason the row exists
	// at all: a reader answering a family question from this table alone must be able to tell this name-match
	// inference from a holding-company membership the filer itself filed.
	insFamily.run(
		matchedFRNNodeID,
		cikNodeID,
		cikNodeID,
		FilerEdgeAssertion.Inferred,
		FilerRelationship.ParentCompany,
		"edgar-exhibit-21",
		filingDate,
		filingDate,
		null,
		matchScore
	)
}

/**
 * Mints the `form499_id:` node id, throwing when `form499ID` is blank — see the module docstring's "malformed input is
 * loud" section. An empty string is NOT a legitimate missing value here (unlike a `null` `frn`): every 499 row has SOME
 * `form499ID` in the real file, so a blank one signals a malformed row, and silently minting `form499_id:` would
 * collapse every such row into one degenerate shared node.
 */
function mintForm499NodeID(form499ID: string, rowIndex: number): string {
	if (form499ID.trim() === "") {
		throw new Error(
			`buildFilerDatabase: malformed form499 row #${rowIndex} — empty form499ID. Refusing to mint a ` +
				`degenerate node_id ("form499_id:") that every other empty-form499ID row would silently collapse ` +
				`into, merging unrelated filers under one shared identity.`
		)
	}

	return `${FilerIdentifierType.Form499ID}:${form499ID}`
}

/**
 * Validates `lastFiledAt` is non-blank before it is written into BOTH `filer_edge.source_vintage`/`valid_from` and
 * every attribute's `source_vintage` for this row (review finding). Decision 7 / gate 1 make `valid_from` MANDATORY on
 * every edge — but `Form499Row.lastFiledAt` is a raw, unvalidated TSV string (`form499.ts`'s own docstring: "no `Date`
 * parsing happens at this layer"), and SQLite's `NOT NULL` does not reject an empty string. An unguarded blank
 * `lastFiledAt` would silently write `source_vintage: ""`/`valid_from: ""` onto every edge/attribute this row produces
 * — a time-scoped read (`valid_from <= asOf`) then treats that edge as valid SINCE FOREVER, exactly the dishonesty
 * decision 7 exists to prevent. Guarded here — in the builder, not in `form499.ts`'s parser — for the same reason
 * {@linkcode mintForm499NodeID} guards `form499ID` here rather than upstream: this file already owns the "which fields
 * are load-bearing for THIS artifact's identity/provenance" discipline, and `form499.ts` is deliberately a raw,
 * non-validating passthrough for every field it doesn't itself need to type (see its own docstring).
 */
function assertLastFiledAt(lastFiledAt: string, form499ID: string, rowIndex: number): string {
	if (lastFiledAt.trim() === "") {
		throw new Error(
			`buildFilerDatabase: malformed form499 row #${rowIndex} (form499ID=${JSON.stringify(form499ID)}) — empty ` +
				`lastFiledAt. Decision 7 / gate 1 make valid_from MANDATORY on every edge; a blank value would silently ` +
				`write source_vintage/valid_from as "" on every edge and attribute this row produces, which a ` +
				`time-scoped (valid_from <= asOf) read would then treat as valid since forever.`
		)
	}

	return lastFiledAt
}

/**
 * Requires + ISO-validates {@link BuildFilerOptions.validFrom} — called once, up front, only when a provider-list source
 * is actually supplied (review fix, round N). Fails fast, before any file/DB I/O, matching the "pass at least one …
 * source" options-level guard just above it in {@linkcode buildFilerDatabase} — this is the same class of check (an
 * options contract violation, not a malformed data row), so it is validated at the same point in the function, not
 * lazily inside the provider-row loop.
 */
function assertProviderValidFrom(validFrom: string | undefined): string {
	if (validFrom === undefined) {
		throw new Error(
			"buildFilerDatabase: options.validFrom is required when a provider-list source (providerRows/" +
				"providerListPath) is supplied — provider-list edges need an ISO YYYY-MM-DD valid_from that is " +
				'SEPARATE from sourceVintage (which may stay a human vintage label like "2026-Q2"); see ' +
				"BuildFilerOptions.validFrom's docstring for why the two must never be the same field."
		)
	}

	return assertISODate(validFrom, "options.validFrom")
}

/**
 * Mints the `bdc_provider_id:` node id, throwing when `providerID` is not a safe integer — mirrors `peekProviderID`'s
 * `Number.isSafeInteger` guard (`build-bdc.ts`:259). `ProviderListRow.providerID` is already validated by
 * {@linkcode parseProviderList} on the production (file-reading) path, but the `providerRows` TEST SEAM bypasses that
 * parser entirely — a directly-constructed row with a `NaN` `providerID` would otherwise mint the node id string
 * `"bdc_provider_id:NaN"`, silently merging every malformed row under that one shared identity, the same failure class
 * the module docstring describes for `form499ID`.
 */
function mintProviderNodeID(providerID: number, rowIndex: number): string {
	if (!Number.isSafeInteger(providerID)) {
		throw new TypeError(
			`buildFilerDatabase: malformed provider-list row #${rowIndex} — providerID did not parse to a safe ` +
				`integer (got ${JSON.stringify(providerID)}). Refusing to mint a degenerate node_id that every other ` +
				`malformed row would silently collapse into.`
		)
	}

	return `${FilerIdentifierType.BDCProviderID}:${providerID}`
}

/**
 * Create every table this builder writes to, in one place — split out of {@linkcode buildFilerDatabase} itself purely
 * to stay under the linter's `max-statements` ceiling, once `filer_family`'s creation call joined `filer_cluster`'s in
 * the 3b family-membership work; no behavioral difference from inlining these calls at the original call site.
 * `filer_cluster` and `filer_family` are both created EMPTY here, for schema completeness — see the module docstring
 * for who populates each later (`cluster-filers.ts` for the former, this file's family-membership emission for the
 * latter).
 */
async function createFilerBuildTables(kdb: Kysely<FilerDatabase>): Promise<void> {
	await createFilerManifestTable(kdb)
	await createFilerNodeTable(kdb)
	await createFilerEdgeTable(kdb)
	await createFilerAttributeTable(kdb)
	await createFilerClusterTable(kdb)
	await createFilerFamilyTable(kdb)
	await createFilerAttributeStageTable(kdb)
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
	const kdb = new DatabaseClient<FilerDatabase>({ database: db })

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
	// uniqueness a staging table would otherwise exist to give. naming_node_id belongs in that key (task 3 fix round
	// 4) — see createFilerFamilyTable's docstring for why leaving it out would make THIS statement's OR IGNORE drop a
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

	for await (const row of form499Source) {
		form499RowIndex++

		const form499NodeID = mintForm499NodeID(row.form499ID, form499RowIndex)
		insNode.run(form499NodeID, FilerIdentifierType.Form499ID, row.form499ID)

		// Guarded ONCE per row, before anything below writes it into source_vintage/valid_from — see the
		// docstring above assertLastFiledAt (review finding). ISO-validated too (review fix,
		// round N): this SAME value becomes valid_from on every edge this row emits, and valid_from must
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

		if (row.frn) {
			skipped += processForm499FRNRelationships(insNode, insEdge, insFamily, legalNameByFRN, {
				row,
				frn: row.frn,
				form499NodeID,
				form499RowIndex,
				lastFiledAt,
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
		// providerValidFrom — see BuildFilerOptions.validFrom's docstring (review fix, round N). Non-null
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
	// processEdgarSubsidiaryRow's docstring for the per-row edge/family logic (pulled out to a module-level
	// function purely to stay under the linter's max-statements ceiling, the identical reason
	// insertFamilyMembership is its own function rather than inlined here).
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
			// Bumped 1 -> 2 (3b Task 1, decisions 1, 2): filer_edge gained the NOT NULL relationship column and
			// filer_family is a new table — both are shape changes to the artifact this version number describes.
			schema_version: 2,
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
	}
}
