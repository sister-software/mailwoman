# Filer Spine Phase 3a Implementation Plan — identity crosswalk core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land `@mailwoman/filer` producing `filer.db` — a provenanced, time-scoped identity-crosswalk graph over FCC filer identifiers, with entity clustering through the existing matcher and a `filer_lookup` MCP tool.

**Architecture:** A data-acquisition workspace mirroring `bdc/` (`filer/sdk` fetch/parse + schema + readers + builder). Nodes are `(identifier_type, value)`; edges are provenanced assertions. Authoritative edges come from documents stating two identifiers in one row; inferred edges come from `@mailwoman/registry`'s `resolveEntities`. Build-then-seal-then-swap, copying `bdc/sdk/build-bdc.ts` exactly.

**Tech Stack:** as 2a/2b. All Global Constraints from `2026-07-30-bdc-2a-plan.md` bind here verbatim (no enum, no raw `process.env`, oxfmt before commit, Kysely DDL + raw hot inserts, sealed artifacts, salvage rules, acronym casing).

**Spec:** `docs/superpowers/specs/2026-07-31-filer-spine-design.md` (§3.1, §4, §6-3a, decisions D1-D7) + `2026-07-31-transaction-layer-and-portability.md` §2. Recon (2026-07-31) found five contradictions; decisions below resolve them.

## Verification ladder (every task)

`yarn vitest run filer bdc registry match mcp` · full untargeted `yarn tsc -b` · **`yarn typecheck:tests`** — the third is mandatory: `satisfies` pins are invisible to both of the others (2b final-review finding).

## Pre-registered decisions (cite in commits)

1. **3a's crosswalk core is Form 499 + the BDC provider list; CORES arrives as a bounded enrichment pass (Task 9), not via the Nexus scraper.** _Revised 2026-07-31 after operator pushback — the first draft deferred CORES entirely, which over-generalized from "the salvage has no bulk loader" to "no good source exists." That does not follow, and it was wrong._ What research established: the FCC publishes a documented **FRN API** (`data.fcc.gov/api/frn`, the "FRN Conversions" GetInfo call) returning company name **plus parent and subsidiary names**, and a Postman-documented Relationship-FRN endpoint. That is a supported interface, not an HTML scrape, and the parent/subsidiary fields make CORES a **family-edge source for 3b** — materially more valuable than the "enrichment" framing of the first draft.
   Still true: no CORES **bulk** extract was found (the FCC's bulk downloads cover ULS and ASR, not CORES). But per-FRN calls are acceptable here precisely because 499 + the provider list first give us a **finite, enumerated FRN universe** — this is a bounded enrichment job over a known key set, not an unbounded crawl for discovery. Cache per FRN, rate-limit, identify the client.
   **Blocked on verification:** `www.fcc.gov` and `data.fcc.gov` return 403 at the Akamai edge from the lab host, so the API's exact response shape, auth needs, and terms are UNVERIFIED. (`broadbandmap.fcc.gov` works fine with credentials, so this is host-specific, not a blanket block.) Task 9 opens with a verification step and stops if the interface is not what the documentation describes.
2. **`filer.db` is NOT a layer-contract artifact in 3a.** It has no coordinates (ASR is 3c) and `layer_coverage` is h3-keyed with no null path, so conforming would mean writing coverage rows that assert nothing — the exact dishonesty the meaning-of-zero rule exists to prevent. 3a ships its own `filer_manifest` table (name, version, source, source_vintage, build_cmd, build_sha, created_at — mirroring `LayerManifestTable`'s fields minus the spatial ones). Layer-contract conformance is deferred to 3c, when ASR structures give coordinates and coverage means something. **Do not geocode filer HQ addresses in 3a** to manufacture a spine.
3. **FRN is a zero-padded 10-character branded string.** Nexus types it `Tagged<number>`; `BDCProviderTable.frn` is already `string | null`. Numeric storage loses leading zeros (same defect class as 2a's `location_id`). Provide `isFRN(value): value is FRN` with a real 10-digit check, unlike the Nexus guard.
4. **Clustering runs with `learnedScorer: false`.** `resolveEntities` defaults to a GBT model trained on **NPPES healthcare dedup** whose threshold is not in Fellegi-Sunter weight units. Corporate-name linkage needs the honest FS path the spec describes. Revisit only with a corporate-trained model.
5. **Authoritative and inferred edges never merge.** Entity clusters are connected components over **authoritative edges only**. Inferred edges are stored with their scores and are queryable, but a rollup that includes them must say so. This is §4.1 and it is a gate.
6. **Cardinality lives in the graph; `bdc_provider` is an explicitly lossy denormalization.** A `provider_id` can carry multiple FRNs and conflicting holding companies (Nexus warns-and-overwrites, last-wins — do not copy that). `filer.db` retains every edge. When `bdc_provider` is populated (task 8), the primary FRN is the one from the most recent 499 filing date, and that rule is documented in the schema docstring. `brand_name` stays NULL — no source in the provider list.
7. **Temporal validity: `valid_from` is mandatory, `valid_to` nullable.** In 3a the only date source is the 499 `lastFiledAt`, so `valid_from` = filing date for 499-derived edges and the file vintage for provider-list edges. Transfer-of-control dates arrive in 3b. Every rollup query takes an `asOf` date.
8. **Streaming, not whole-file reads.** The Nexus 499 loader reads the entire TSV into memory and silently truncates short rows (`relax_column_count_less`). Parse streaming, and a short row is a loud error naming the file and line — malformed input is never silently absorbed (the 2a `peekProviderID` discipline).

## Acceptance gates (§7-3a, pre-registered — Task 7 discharges them)

1. **Provenance completeness (load-bearing).** No edge can exist without `source`, `source_vintage`, `assertion`, and `valid_from`. Enforce structurally: the fields are non-optional on the insert type, pinned with `satisfies Record<keyof FilerEdgeInsert, true>`, and a runtime test asserts a partial edge is rejected.
2. **Authoritative/inferred never conflated.** Clustering over authoritative edges only; a test builds a fixture where an inferred edge _would_ merge two authoritative components and asserts it does not, and that the API surfaces the distinction.
3. **Cardinality fidelity.** A fixture `provider_id` carrying two FRNs round-trips both edges through `filer.db`; the test also asserts the documented primary-FRN rule picks the later-filed one.
4. **Temporal scoping.** Every edge carries `valid_from`; a rollup query with an `asOf` before an edge's `valid_from` excludes it; the result states the `asOf` used.

---

### Task 1: `@mailwoman/filer` workspace skeleton

**Files:** Create `filer/{package.json,tsconfig.json,tsconfig.test.json,index.ts,README.md}`, `filer/sdk/index.ts`. Modify root `package.json` workspaces + root `tsconfig.json` references.

**Produces:** importable empty `@mailwoman/filer` + `@mailwoman/filer/sdk`.

- [x] Copy `bdc/package.json` shape exactly (name `@mailwoman/filer`, same license/engines/exports incl. the dev `node → .ts` condition, `files` array). Deps: `@mailwoman/core`, `@mailwoman/record`, `@mailwoman/registry`, `@mailwoman/match` as `workspace:*`, `kysely ^0.29.4`, `type-fest`. Mirror `bdc/tsconfig.json` with references to those.
- [x] `filer/index.ts` re-exports `./sdk/index.ts` and (later) `./schema.ts`. README: what it is, spec pointer, and the decision-2 sentence (not a layer-contract artifact in 3a, and why).
- [x] Root wiring; `yarn install`; `yarn tsc -b filer` clean; `yarn workspaces list | grep filer`.
- [x] Commit `feat(filer): workspace skeleton for the identity crosswalk (3a task 1)`.

### Task 2: FRN branded type + Form 499 parsing

**Files:** Create `filer/sdk/{frn.ts,form499.ts}` + tests. Source: `/home/lab/Projects/isp-nexus/universe/sync/fcc/universal-service.ts` (columns + classification mapping only — rewrite the loader per decision 8).

**Produces:**

```ts
export type FRN = Tagged<string, "FRN">                    // zero-padded 10 chars
export function isFRN(value: unknown): value is FRN
export function toFRN(value: string | number): FRN | null  // zero-pads, validates
export const FORM_499_COLUMNS = [...] as const              // the 17-name tuple, spec §3.1
export interface Form499Row { form499ID; frn: FRN | null; lastFiledAt: string; usfContributor: boolean;
  legalNameOfCarrier; doingBusinessAs; principalCommType; holdingCompany; managementCompany;
  hqAddress; customerInquiriesTelephone; customerInquiriesAddress; dcAgentDisplayName;
  dcAgentOrganizationName; dcAgentTelephone; dcAgentEmailAddress; dcAgentAddress }
export const FilerClassification = { IncumbentLEC: "incumbent_lec", CLEC: "clec",
  InterExchange: "interexchange", TollReseller: "toll_reseller", USFContributor: "usf_contributor" } as const
export function classifyFiler(row: Form499Row): FilerClassification[]   // port the :164-176 mapping
export async function* parseForm499(tsvPath: string): AsyncIterable<Form499Row>  // STREAMING
```

- [x] Failing tests first: `toFRN(1753557)` → `"0001753557"`; `isFRN("1753557")` false (not 10 chars); a fixture TSV of 3 rows parses to 3 typed rows; a short row throws naming file + line number (decision 8); `classifyFiler` over rows with `principalCommType` containing "Incumbent"/"CLEC"/"Interexchange"/"Toll Reseller" and `usfContributor` TRUE.
- [x] Implement. Two `managementCompany`/`holdingCompany` fields both retained (spec §3.1 finding 1 — they are different assertions). Note in the docstring that `otherTradeName1` exists in the Nexus interface but not its column tuple, and is therefore absent here by design.
- [x] Commit `feat(filer): FRN branded string + streaming Form 499 parser (3a task 2, decisions 3,8)`.

### Task 3: BDC provider list parsing

**Files:** Create `filer/sdk/provider-list.ts` + test + a fixture CSV.

**Produces:**

```ts
export interface ProviderListRow { providerID: number; frn: FRN; holdingCompany: string | null }
export async function* parseProviderList(csvPath: string): AsyncIterable<ProviderListRow>
```

One `provider_id` may appear on multiple rows with different FRNs — **yield every row**; do not dedup or last-wins (decision 6). Fixture must include a provider_id with two FRNs and one with two different holding-company strings.

- [x] TDD; commit `feat(filer): BDC provider-list parser preserving multi-FRN cardinality (3a task 3, decision 6)`.

### Task 4: `filer.db` schema

**Files:** Create `filer/schema.ts` + test. Style precedent: `bdc/schema.ts` (typed interface + co-located `create*Table`).

**Produces:**

```ts
export const FilerIdentifierType = {
	FRN: "frn",
	Form499ID: "form499_id",
	SPIN: "spin",
	BDCProviderID: "bdc_provider_id",
	HoldingCompanyName: "holding_company_name",
	ManagementCompanyName: "management_company_name",
} as const
export const FilerEdgeAssertion = { Authoritative: "authoritative", Inferred: "inferred" } as const
export interface FilerNodeTable {
	node_id: string /* PK: `${type}:${value}` */
	identifier_type: string
	identifier_value: string
}
export interface FilerEdgeTable {
	from_node_id: string
	to_node_id: string
	assertion: string // FilerEdgeAssertion
	source: string // e.g. "form-499", "bdc-provider-list"
	source_vintage: string // file vintage / filing date
	valid_from: string // MANDATORY (decision 7, gate 4)
	valid_to: string | null
	match_score: number | null // inferred only
	evidence: string | null // JSON, inferred only
}
export interface FilerAttributeTable {
	node_id: string
	key: string
	value: string
	source: string
	source_vintage: string
}
export interface FilerClusterTable {
	node_id: string
	cluster_id: string
	assertion: string
}
export interface FilerManifestTable {
	name: string
	version: string
	schema_version: number
	source: string
	source_vintage: string
	build_cmd: string
	build_sha: string
	created_at: string
}
export interface FilerDatabase {
	filer_node
	filer_edge
	filer_attribute
	filer_cluster
	filer_manifest
}
export async function createFilerNodeTable(db): Promise<void> // + Edge, Attribute, Cluster, Manifest, and index builders
```

Edge PK `(from_node_id, to_node_id, source, valid_from)` so the same relationship asserted by two sources or two vintages is two rows, not a clobber.

- [x] TDD: in-memory DatabaseClient, all tables created, a typed edge round-trips, and the manifest is single-row-enforced (copy `readLayerManifest`'s throw-unless-exactly-one discipline).
- [x] Commit `feat(filer): filer.db schema — provenanced time-scoped crosswalk (3a task 4, decisions 2,7)`.

### Task 5: The builder

**Files:** Create `filer/sdk/build-filer.ts` + test. Copy `bdc/sdk/build-bdc.ts`'s flow verbatim: `${out}.building` → pragmas → shared handle (`DatabaseClient` for DDL, raw prepared statements for hot inserts) → stage-table dedup via composite-PK `INSERT OR IGNORE` → materialize → index-after-load → manifest → `ANALYZE`/`VACUUM` → `sealDatabase` → rename old to `.prev` → rename into place. Also copy the `asContractDB`-style Kysely invariance cast if needed.

**Produces:**

```ts
export interface BuildFilerOptions {
	form499Rows?: AsyncIterable<Form499Row> | Iterable<Form499Row>
	providerRows?: AsyncIterable<ProviderListRow> | Iterable<ProviderListRow>
	form499Path?: string
	providerListPath?: string
	out: string
	sourceVintage: string
	buildSHA: string
	onProgress?: (m: string) => void
}
export interface BuildFilerResult {
	out: string
	nodes: number
	edges: number
	attributes: number
	skipped: number
}
export async function buildFilerDatabase(options: BuildFilerOptions): Promise<BuildFilerResult>
```

Authoritative edges emitted: FRN↔form499ID, FRN↔holdingCompanyName, FRN↔managementCompanyName (both, per decision), bdcProviderID↔FRN, bdcProviderID↔holdingCompanyName. Attributes: legal name, DBA, classifications, contact fields. `valid_from` per decision 7.

- [x] TDD via the rows seams (no file IO in tests). Assert: a malformed row is loud; a provider_id with two FRNs yields two edges; every edge has non-empty provenance; the manifest carries the vintage.
- [x] Commit `feat(filer): filer.db builder — authoritative edges, staged dedup, sealed artifact (3a task 5)`.

### Task 6: Entity clustering

**Files:** Create `filer/sdk/cluster-filers.ts` + test.

Two passes: (a) **authoritative components** — feed authoritative edges to `cluster()` from `@mailwoman/match` (`match/clustering.ts:112`) as `ScoredLink`s with `weight: Infinity`, writing `filer_cluster` rows with `assertion: "authoritative"`; (b) **inferred links** — build `SourceRecord`s (`registry/types.ts:15`) from filer nodes with `organization` = canonicalized legal name (`record/organization.ts` `canonicalizeOrganizationName`), `address` = HQ, and `attributes` carrying FRN/form499ID/providerID as code-set strings, then call `resolveEntities(records, { exactDiscriminators: [...], learnedScorer: false })` (decision 4) and write the resulting links as `assertion: "inferred"` edges with their scores. **Inferred links never modify authoritative cluster assignments** (decision 5, gate 2).

- [x] TDD including gate 2's fixture: two authoritative components that an inferred edge would bridge; assert the authoritative clustering is unchanged and the inferred edge is recorded separately.
- [x] Commit `feat(filer): authoritative clustering + inferred linkage, never conflated (3a task 6, decisions 4,5)`.

### Task 7: Readers, the four gates, and the `filer_lookup` MCP tool

**Files:** Create `filer/sdk/filer-lookup.ts` + test (the gates live here); modify `mcp/{tools.ts,cli.ts,layer-guards.ts,tools.test.ts,package.json,tsconfig.json}`.

**Produces:**

```ts
export interface FilerLookupQuery {
	frn?: FRN
	form499ID?: string
	bdcProviderID?: number
	asOf?: string
}
export interface FilerLookupResult {
	node
	identifiers: { type; value; source; source_vintage }[]
	attributes: Record<string, string>
	cluster: { cluster_id; members } | null
	inferred_links: { to; score; source }[]
	as_of: string
	vintage: string
}
export async function filerLookup(
	db: DatabaseClient<FilerDatabase>,
	query: FilerLookupQuery
): Promise<FilerLookupResult>
```

Exactly one identifier required (throw otherwise, matching `filingLandscape`'s XOR discipline). `as_of` defaults to today and is ALWAYS present in the result. Manifest read first — throw rather than answer unstamped.

MCP: `mailwoman_filer_lookup` matching the house pattern exactly (snake_case zod with `.describe()` on every field, `MCPToolDeps` method, parse → deps → verbatim), plus `openFilerDatabaseIfPresent`/`assertFilerDatabaseExists` in `mcp/layer-guards.ts` following the 2b precedent.

- [x] **Gate tests, written first, in a `describe("§7-3a gates")` block** — the four gates verbatim from this plan's Acceptance Gates section, including gate 1's structural pin (`satisfies Record<keyof FilerEdgeInsert, true>`) and a runtime rejection test.
- [x] Commit `feat(filer,mcp): filer_lookup reader, the four 3a gates, MCP tool (3a task 7)`.

### Task 8: Populate `bdc_provider` (cross-workspace)

**Files:** Modify `bdc/sdk/build-bdc.ts` (+ `BuildBDCOptions.providers?`), `bdc/schema.ts` (docstring only — the primary-FRN rule), `mailwoman/commands/gazetteer/build/bdc.tsx` (flag), tests.

`bdc.db` is sealed and atomically swapped, so this is a **rebuild path**, not an in-place write (recon finding 4). Add an optional `providers?: Iterable<ProviderListRow>` to `BuildBDCOptions`; when present, populate `bdc_provider` during the build. Primary FRN = the one from the most recent 499 filing date; `brand_name` stays NULL (no source — document it). Verify the default path (no `providers`) produces byte-identical output to today.

- [x] TDD; assert default-path behavior unchanged and the lossy-denormalization rule is exercised by a multi-FRN fixture.
- [x] Commit `feat(bdc): optional provider population during build (3a task 8, decision 6)`.

### Task 9: CORES enrichment via the documented FRN API — **STOPPED AT THE GATE (2026-07-31), deferred to 3b**

**Step 0 outcome, recorded:** the stop gate fired and the task was not implemented. Probes from the lab host, with an identifying User-Agent naming the project and a contact address:

- `https://data.fcc.gov/api/frn/getInfo?frn=0001753557&format=json` → **403 Access Denied** at the Akamai edge (`errors.edgesuite.net` reference). The identifying UA did not change the outcome, so the block is host/IP-based, not agent-based.
- `https://apps.fcc.gov/cores/api/frn/0001753557` → an HTML **"Invalid Request"** page, not JSON. That guessed path is not the documented interface.

Per the gate's own terms — _"if the host 403s from this machine, or the response does not carry the documented fields, STOP and report — do not fall back to the Nexus HTML scrape"_ — no fallback was attempted and no code was written. Note `broadbandmap.fcc.gov` continues to work with credentials, so this is specific to these hosts rather than a blanket FCC block.

**What remains true:** the FRN Conversions API is documented publicly and reportedly returns parent and subsidiary names, which would make it a family-edge source rather than mere enrichment. Nothing about that claim was disproven — it simply could not be verified from here.

**Carried to 3b** with two prerequisites: (1) run Step 0 from a network path that can reach `data.fcc.gov` (the operator's own machine is the obvious candidate) and record the real response shape, auth requirements, and terms; (2) only then implement, keeping the bounded-enumeration posture — the FRN universe comes from the already-built crosswalk, so this is enrichment over a known key set, never a crawl.

<details>
<summary>Original task specification (unimplemented, retained for 3b)</summary>

**Files:** Create `filer/sdk/cores.ts` + test. Modify `filer/sdk/build-filer.ts` to accept the enrichment as an optional input.

**Step 0 is a STOP GATE.** Verify the interface actually exists and behaves as documented before writing anything: hit `data.fcc.gov/api/frn` (the FRN Conversions GetInfo call) for a known FRN — use `0001753557` (WideOpenWest Finance, LLC, from the operator's field example) and `0003768165` (Comcast) — and record the real response shape, whether parent/subsidiary names are present, whether auth is required, and any published rate limit or terms. **If the host 403s from this machine, or the response does not carry the documented fields, STOP and report — do not fall back to the Nexus HTML scrape, and do not proceed to the remaining steps.** The lab host was blocked at the Akamai edge on 2026-07-31; the operator may need to run this step, or it may work from a different network path.

**Produces (only if Step 0 passes):**

```ts
export interface CORESEntity { frn: FRN; entityName: string | null; parentName: string | null
  subsidiaryNames: string[]; entityType: string | null; retrievedAt: string }
export async function fetchCORESEntity(frn: FRN, opts?: { fetchImpl?: typeof fetch; cacheDir?: string }): Promise<CORESEntity | null>
export async function* enrichFromCORES(frns: Iterable<FRN>, opts?): AsyncIterable<CORESEntity>
```

Bounded by construction: the FRN set comes from the already-built crosswalk, so this enumerates a known finite key set rather than crawling for discovery. Per-FRN filesystem cache keyed by FRN + retrieval date; serial or small-concurrency requests with a descriptive User-Agent; a documented pause between calls. Tests use a stub `fetchImpl` — **no live network calls in the test suite**.

Edges emitted (authoritative, since CORES states them): `frn ↔ parentName`, `frn ↔ subsidiaryName` (one edge per subsidiary), `source: "cores"`, `source_vintage` = retrieval date. These are the family-edge seeds 3b builds on.

- [x] Step 0 stop gate — **FIRED; task not implemented, deferred to 3b.**

</details>

### Task 10: Wrap-up

- [x] Full ladder incl. `yarn typecheck:tests`; tick plan checkboxes; controller handles final review + PR (do NOT open a PR in-task).

## Out of scope for 3a (do not build)

Layer-contract conformance for filer.db (decision 2); geocoding filer HQ addresses; SEC/EDGAR and corporate families (3b); ASR/ULS (3c); `competition(area)` (3d); transfer-of-control edges (3b — but the schema's `valid_from`/`valid_to` must accept them without migration).

## Self-review notes

Spec §3.1 columns → T2 (both family fields retained; DC-agent-as-family-edge explicitly NOT emitted, per the spec's anti-pattern warning). §4.1 graph → T4/T5. §4.1 clustering → T6. §6-3a `bdc_provider` → T8. Transaction-layer §2 `valid_from` → T4/T5 with 3b extensibility. Types: `FRN` (T2) flows through T3/T4/T5/T7; `Form499Row`/`ProviderListRow` (T2/T3) feed `BuildFilerOptions` (T5); `FilerDatabase` (T4) feeds T5/T6/T7/T8.
