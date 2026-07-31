/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `filer.db` builder (3a Task 5) — ingests Task 2's {@link Form499Row} and Task 3's
 *   {@link ProviderListRow} into Task 4's schema (`../schema.ts`), producing a sealed identity-crosswalk
 *   artifact. Copies `bdc/sdk/build-bdc.ts`'s flow verbatim: `${out}.building` → build-tuning pragmas →
 *   ONE `DatabaseSync` handle wrapped in a `DatabaseClient` for DDL while hot inserts use raw prepared
 *   statements on that SAME handle → create tables → stage-table dedup via composite-PK
 *   `INSERT OR IGNORE` batched with `BEGIN`/`COMMIT` → materialize via `INSERT … SELECT` →
 *   index-after-load → write manifest → `ANALYZE`/`VACUUM` → `sealDatabase` → rename existing `out` to
 *   `.prev` → rename `.building` into place. `filer.db` is NOT a layer-contract artifact (decision 2), so
 *   there is no `@mailwoman/core/layers` call here and no `asContractDB`-style invariance cast is needed —
 *   the manifest is a plain `filer_manifest` insert via Kysely, not `writeLayerManifest`.
 *
 *   **Node/edge/family dedup — no staging table needed.** `filer_node` (PK `node_id`), `filer_edge` (PK
 *   `(from_node_id, to_node_id, source, valid_from)`, Task 4), and `filer_family` (PK `(node_id, family_id,
 *   source, valid_from)`, Task 1 — the identical composite shape as `filer_edge`'s) already carry the
 *   uniqueness constraint a staging table would otherwise exist to provide — so all three are written
 *   directly via raw prepared `INSERT OR IGNORE` against the PRODUCTION table. This *is* "the way edges are
 *   handled" the Task 4 review referenced: the composite PK, not a separate staging pass, is the dedup
 *   mechanism, and 3b Task 2's family-membership writes reuse it rather than growing a second staging table
 *   the PK already makes unnecessary.
 *
 *   **Attribute dedup — a real staging table, because `filer_attribute` has no PK.** Task 4's review
 *   flagged `filer_attribute`/`filer_cluster` as carrying no uniqueness constraint, so a same-source/
 *   same-vintage double-insert (e.g. the same 499 row processed twice, or two rows independently
 *   asserting the identical fact) would silently duplicate. This builder makes the write path idempotent
 *   by staging every attribute write into `filer_attribute_stage` — a build-only table (dropped before the
 *   artifact seals, same lifecycle as `bdc_stage`) carrying a composite PRIMARY KEY on the natural key
 *   `(node_id, key, value, source, source_vintage)` — then materializing into `filer_attribute` via
 *   `INSERT … SELECT`. `value` is part of the key (not just `node_id, key, source, source_vintage`)
 *   because ONE key can legitimately carry several distinct values from the same source at the same
 *   vintage (e.g. `classification` — a filer can be both a USF contributor AND an Incumbent LEC); only a
 *   literal repeat of the whole tuple is a duplicate to collapse.
 *
 *   `filer_cluster` is created (empty) for schema completeness — Task 6's `cluster-filers.ts` populates it
 *   in a later build pass; this builder never writes to it, so its own PK-less idempotency question is out
 *   of scope here.
 *
 *   **Malformed input is loud, never silently deduped** (`peekProviderID`'s discipline,
 *   `bdc/sdk/build-bdc.ts`:237): an empty `form499ID` cannot be told apart from any other empty
 *   `form499ID` once mangled into a node identity — silently accepting it would mint ONE degenerate
 *   `form499_id:` node that every empty-ID row collapses into, merging unrelated filers under one
 *   identity. This throws instead, naming the offending row. Likewise an empty `frn` (on EITHER row
 *   shape — see {@linkcode mintFRNNodeID}) and an empty `lastFiledAt` (see {@linkcode assertLastFiledAt}
 *   — fix round 1, CRITICAL: an unguarded blank `lastFiledAt` was silently written into
 *   `source_vintage`/`valid_from` as `""`, which SQLite's `NOT NULL` does not reject, breaking decision
 *   7 / gate 1's "valid_from is MANDATORY" invariant). A `null` `frn` on a {@link Form499Row} (Task 2's
 *   {@link Form499Row.frn}) is the opposite case — common and legitimate (a filer not yet registered in
 *   CORES) — so it is never an error, only a counted {@link BuildFilerResult.skipped} opportunity.
 *
 *   **Edges emitted (all `assertion: "authoritative"` — Task 5 never writes inferred edges; that is
 *   Task 6's `cluster-filers.ts`, over `@mailwoman/match`):**
 *
 *   - From a {@link Form499Row} with a non-null `frn`: `FRN↔form499ID`, `FRN↔holdingCompanyName` (when
 *     `holdingCompany` is non-empty), `FRN↔managementCompanyName` (when `managementCompany` is
 *     non-empty — a SEPARATE edge from the holding-company one; spec §3.1 finding 1, ownership and
 *     operational control are different assertions, never collapsed). `source_vintage` and `valid_from`
 *     both take the row's own `lastFiledAt` (decision 7 — the only per-row date 499 offers).
 *   - From a {@link ProviderListRow}: `bdcProviderID↔FRN` (always — `frn` is never null on this row
 *     shape) and `bdcProviderID↔holdingCompanyName` (when `holdingCompany` is non-null). `source_vintage`
 *     takes `options.sourceVintage` (decision 7 — the provider list carries no per-row date, only a
 *     whole-file vintage) but `valid_from` takes the SEPARATE `options.validFrom` (review fix, round N,
 *     CRITICAL) — see {@link BuildFilerOptions.validFrom}'s docstring for why the two must never be the
 *     same field: `sourceVintage` is a free-text human label (`"2026-Q2"`) that is not guaranteed
 *     ISO-sortable, and `valid_from` participates in every downstream `asOf` predicate as a plain string
 *     comparison.
 *
 *   The direction convention (documented, not semantically load-bearing — `filer_edge` asserts symmetric
 *   sameness, and the `to_node_id` index makes either traversal direction cheap): FRN is `from` for
 *   499-derived edges (it is the identifier hub — spec §3), `bdcProviderID` is `from` for provider-list
 *   edges (the row's own natural anchor).
 *
 *   **`relationship` is fully typed (3b Task 2, decisions 1, 2) — 3b Task 1 shipped a uniform `SameEntity`
 *   placeholder at every site below; this reclassifies each to its correct named kind.** `FRN↔form499ID`
 *   and `bdcProviderID↔FRN` assert identity — the same underlying filer under a different identifier — so
 *   both stay `FilerRelationship.SameEntity`. `FRN↔holdingCompanyName` AND `bdcProviderID↔holdingCompanyName`
 *   are ownership facts (`FilerRelationship.HoldingCompany`); `FRN↔managementCompanyName` is operational
 *   control, never collapsed into the holding-company kind (spec §3.1 finding 1) —
 *   `FilerRelationship.ManagementCompany`.
 *
 *   **`filer_family` is populated alongside every `HoldingCompany`/`ManagementCompany` edge (3b Task 2).** A
 *   `holding_company_name` (or `management_company_name`) node with N distinct FRN/`bdcProviderID` members
 *   pointing at it is a corporate family of N members — {@linkcode mintFamilyID} derives a stable
 *   `family_id` from the target name's CANONICAL form (`canonicalizeOrganizationName`, `@mailwoman/record`
 *   — the same reduction `cluster-filers.ts`'s inferred pass already relies on), namespaced by identifier
 *   type so a holding company and a differently-named management company never collapse into one family
 *   even if their canonical strings happened to coincide. Each `filer_family` row carries the SAME
 *   `relationship`/`source`/`source_vintage`/`valid_from` as the edge that implies it, and `valid_to: null`
 *   (a fresh assertion, never pre-closed). **Never derived from a DC-agent field** — see the DC-agent
 *   doctrine below; those fields never reach an edge, so by construction they can never reach a family
 *   either.
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
 *   **`filer.db` is a single-vintage SNAPSHOT, not a multi-vintage archive (review finding, MINOR-B, fix
 *   round 1 — pin this before Task 6 reads the artifact).** The build-then-seal-then-swap discipline
 *   (`${out}.building` → `sealDatabase` → rename existing `out` to `.prev` → rename into place) means a
 *   SECOND `buildFilerDatabase` call against the SAME `out` with a LATER `sourceVintage` REPLACES the
 *   whole artifact — the earlier vintage's rows do not survive alongside the new ones as additional
 *   `filer_edge`/`filer_attribute` rows. Decision 7's "two vintages can coexist as two rows" scenario is
 *   a property of the SCHEMA (the edge PK includes `valid_from`, so two DIFFERENT `valid_from` values for
 *   the same `(from, to, source)` are two distinct rows) — but it's reachable only by feeding rows
 *   spanning multiple vintages into ONE `buildFilerDatabase` call (e.g. a combined `form499Rows` iterable
 *   drawn from several historical filing snapshots), never by calling this function twice at different
 *   `sourceVintage`s against the same `out`. Any consumer that reads across builds (Task 6's
 *   `cluster-filers.ts`, any future incremental-build task) must NOT assume cross-build accumulation —
 *   each successful build is a complete, self-contained replacement of what "the crosswalk" means as of
 *   that one `sourceVintage`. Multi-vintage accumulation, if ever needed, would require an
 *   accumulate-into-existing-artifact build mode this function does not implement.
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
import { classifyFiler, parseForm499, type Form499Row } from "./form499.ts"
import { assertISODate } from "./guards.ts"
import { parseProviderList, type ProviderListRow } from "./provider-list.ts"

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
	 * ISO `YYYY-MM-DD` date for `valid_from` on every provider-list-derived edge (review fix, round N, CRITICAL) —
	 * deliberately a SEPARATE field from {@link BuildFilerOptions.sourceVintage}, never derived from it. The provider
	 * list carries no per-row date, so decision 7 originally used the whole-file `sourceVintage` for BOTH
	 * `source_vintage` and `valid_from` — but `sourceVintage` is a free-text human vintage label (e.g. `"2026-Q2"`), not
	 * guaranteed ISO-sortable, while `valid_from` participates in every downstream `asOf`-scoped predicate
	 * (`filer-lookup.ts`'s `valid_from <= asOf`) as a plain STRING comparison. `"2026-Q2"` sorts lexicographically ABOVE
	 * any real ISO date this century (`"Q"` > any ASCII digit) — writing it into `valid_from` silently breaks every
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
	 * Distinct `filer_family` rows after the build (3b Task 2) — PK-deduped on `(node_id, family_id, source,
	 * valid_from)`, the identical composite shape as `filer_edge`'s own PK. One row per `HoldingCompany`/
	 * `ManagementCompany` edge whose target name canonicalized to something non-empty (see {@linkcode mintFamilyID}).
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
 * link joining unrelated filers, the worst failure class this crosswalk can produce (review finding, fix round 1).
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

/**
 * Derive a stable `filer_family.family_id` from a holding-/management-company name's CANONICAL form — never the raw
 * string — so `"Acme Holdings Inc"` and `"ACME HOLDINGS, INC."` (same underlying entity, different casing/
 * punctuation/legal suffix) collapse onto the SAME family, the identical reduction `cluster-filers.ts`'s inferred pass
 * already relies on (`canonicalizeOrganizationName`, `@mailwoman/record`). Namespaced by `identifierType`
 * (`holding_company_name` vs `management_company_name`) so a holding company and a DIFFERENT management company that
 * happen to canonicalize to the same string never collapse into one family (spec §3.1 finding 1 — ownership and
 * operational control are different assertions, and that separation should hold for family membership too, not just for
 * the edge kind).
 *
 * Returns `null` when the name canonicalizes to an EMPTY string (rare — e.g. a bare legal-designation token with
 * nothing else surviving) — the same defensive check `cluster-filers.ts`'s `buildInferredRecords` makes before using a
 * canonical name as a blocking key: an empty canonical string can never usefully identify a family, so the caller skips
 * emitting a family row for it. The underlying `HoldingCompany`/`ManagementCompany` EDGE is unaffected — this only
 * gates the family-MEMBERSHIP fact.
 */
function mintFamilyID(identifierType: string, name: string): string | null {
	const organization = canonicalizeOrganizationName(name)

	if (!organization || !organization.canonical) return null

	return `${identifierType}:${organization.canonical}`
}

/**
 * Write one `filer_family` membership row for a `HoldingCompany`/`ManagementCompany` edge's SOURCE node (the edge's own
 * `from_node_id` — an FRN or `bdcProviderID`) — see {@linkcode mintFamilyID} for how `family_id` is derived from the
 * TARGET name's canonical form. Skips silently (no row, no error, no `skipped` increment — a family row is a bonus
 * derived fact, not an edge opportunity) when the name canonicalizes to nothing. Module-level (not a closure inside
 * {@linkcode buildFilerDatabase}, unlike `stageAttribute`/`commitBatch`) purely to stay under the linter's
 * `max-statements` ceiling — `insFamily` (the prepared statement it writes through) is passed in rather than closed
 * over.
 */
function insertFamilyMembership(
	insFamily: StatementSync,
	memberNodeID: string,
	identifierType: string,
	name: string,
	relationship: string,
	source: string,
	sourceVintage: string,
	validFrom: string
): void {
	const familyID = mintFamilyID(identifierType, name)

	if (!familyID) return

	insFamily.run(memberNodeID, familyID, relationship, source, sourceVintage, validFrom, null)
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
 * every attribute's `source_vintage` for this row (review finding, CRITICAL, fix round 1). Decision 7 / gate 1 make
 * `valid_from` MANDATORY on every edge — but `Form499Row.lastFiledAt` is a raw, unvalidated TSV string (`form499.ts`'s
 * own docstring: "no `Date` parsing happens at this layer"), and SQLite's `NOT NULL` does not reject an empty string.
 * An unguarded blank `lastFiledAt` would silently write `source_vintage: ""`/`valid_from: ""` onto every edge/attribute
 * this row produces — a time-scoped read (`valid_from <= asOf`) then treats that edge as valid SINCE FOREVER, exactly
 * the dishonesty decision 7 exists to prevent. Guarded here — in the builder, not in `form499.ts`'s parser — for the
 * same reason {@linkcode mintForm499NodeID} guards `form499ID` here rather than upstream: this file already owns the
 * "which fields are load-bearing for THIS artifact's identity/provenance" discipline, and `form499.ts` is deliberately
 * a raw, non-validating passthrough for every field it doesn't itself need to type (see its own docstring).
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
 * is actually supplied (review fix, round N, CRITICAL). Fails fast, before any file/DB I/O, matching the "pass at least
 * one … source" options-level guard just above it in {@linkcode buildFilerDatabase} — this is the same class of check
 * (an options contract violation, not a malformed data row), so it is validated at the same point in the function, not
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
 * Create every table this builder writes to, in one place — split out of {@linkcode buildFilerDatabase} itself (3b Task
 *
 * 1. Purely to stay under the linter's `max-statements` ceiling once `filer_family`'s creation call joined
 *    `filer_cluster`'s; no behavioral difference from inlining these calls at the original call site. `filer_cluster`
 *    and `filer_family` are both created EMPTY here, for schema completeness — see the module docstring for who
 *    populates each later (Task 6's `cluster-filers.ts` for the former, 3b Task 2 for the latter).
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

	if (!hasForm499Source && !hasProviderSource) {
		throw new Error("buildFilerDatabase: pass at least one of form499Rows/form499Path or providerRows/providerListPath")
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

	const db = new DatabaseSync(buildingPath)
	// Build-tuning pragmas — identical to build-bdc.ts's discipline.
	db.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")
	const kdb = new DatabaseClient<FilerDatabase>({ database: db })

	progress("creating manifest/node/edge/attribute/cluster/family/attribute-stage tables")
	await createFilerBuildTables(kdb)

	const insNode = db.prepare(
		`INSERT OR IGNORE INTO filer_node (node_id, identifier_type, identifier_value) VALUES (?, ?, ?)`
	)

	// relationship (3b Task 2): FRN<->form499ID and bdcProviderID<->FRN assert identity (SameEntity); the
	// holding-/management-company edges below assert HoldingCompany/ManagementCompany — see the module docstring's
	// "relationship is fully typed" section.
	const insEdge = db.prepare(
		`INSERT OR IGNORE INTO filer_edge (
			from_node_id, to_node_id, assertion, relationship, source, source_vintage, valid_from, valid_to, match_score, evidence
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)

	// filer_family (3b Task 2) — same "no staging table needed" discipline as filer_node/filer_edge above (module
	// docstring): the composite PK (node_id, family_id, source, valid_from) already provides the uniqueness a
	// staging table would otherwise exist to give.
	const insFamily = db.prepare(
		`INSERT OR IGNORE INTO filer_family (
			node_id, family_id, relationship, source, source_vintage, valid_from, valid_to
		) VALUES (?, ?, ?, ?, ?, ?, ?)`
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

	let form499RowIndex = 0

	for await (const row of form499Source) {
		form499RowIndex++

		const form499NodeID = mintForm499NodeID(row.form499ID, form499RowIndex)
		insNode.run(form499NodeID, FilerIdentifierType.Form499ID, row.form499ID)

		// Guarded ONCE per row, before anything below writes it into source_vintage/valid_from — see the
		// docstring above assertLastFiledAt (review finding, CRITICAL, fix round 1). ISO-validated too (review fix,
		// round N, CRITICAL): this SAME value becomes valid_from on every edge this row emits, and valid_from must
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
			const frnContext = `form499 row #${form499RowIndex} (form499ID=${JSON.stringify(row.form499ID)})`
			const frnNodeID = mintFRNNodeID(row.frn, frnContext)
			insNode.run(frnNodeID, FilerIdentifierType.FRN, row.frn)

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

				insertFamilyMembership(
					insFamily,
					frnNodeID,
					FilerIdentifierType.HoldingCompanyName,
					row.holdingCompany,
					FilerRelationship.HoldingCompany,
					"form-499",
					lastFiledAt,
					lastFiledAt
				)
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

				insertFamilyMembership(
					insFamily,
					frnNodeID,
					FilerIdentifierType.ManagementCompanyName,
					row.managementCompany,
					FilerRelationship.ManagementCompany,
					"form-499",
					lastFiledAt,
					lastFiledAt
				)
			} else {
				skipped++
			}
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
		// providerValidFrom — see BuildFilerOptions.validFrom's docstring (review fix, round N, CRITICAL). Non-null
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

			insertFamilyMembership(
				insFamily,
				providerNodeID,
				FilerIdentifierType.HoldingCompanyName,
				row.holdingCompany,
				FilerRelationship.HoldingCompany,
				"bdc-provider-list",
				options.sourceVintage,
				providerValidFrom!
			)
		} else {
			skipped++
		}

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
			// that isn't there (review fix, minor).
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
