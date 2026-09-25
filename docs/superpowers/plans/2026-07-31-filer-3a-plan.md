# Filer Spine Phase 3a Implementation Plan — identity crosswalk core

> **For agentic workers:** required sub-skill: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land `@mailwoman/filer`, which produces `filer.db`. The database is a provenanced, time-scoped identity-crosswalk graph over FCC filer identifiers. It clusters entities through the existing matcher and exposes a `filer_lookup` MCP tool.

**Architecture:** A data-acquisition workspace laid out like `bdc/`, with fetch/parse, schema, readers and builder under `filer/sdk`. Nodes are `(identifier_type, value)` pairs, and edges are provenanced assertions. Authoritative edges come from documents that state two identifiers in one row. Inferred edges come from `@mailwoman/registry`'s `resolveEntities`. The build writes, seals, then swaps the file, copying `bdc/sdk/build-bdc.ts` exactly.

**Tech Stack:** the same as 2a/2b. All Global Constraints from `2026-07-30-bdc-2a-plan.md` apply here verbatim: avoid enums and raw `process.env`, run oxfmt before commit, use Kysely DDL with raw hot inserts, seal artifacts, and follow the salvage rules and acronym casing.

**Spec:** `docs/superpowers/specs/2026-07-31-filer-spine-design.md` (§3.1, §4, §6-3a, decisions D1-D7) and `2026-07-31-transaction-layer-and-portability.md` §2. Recon on 2026-07-31 found five contradictions, and the decisions below resolve them.

## Verification ladder (every task)

`yarn vitest run filer bdc registry match mcp` · full untargeted `yarn tsc -b` · **`yarn typecheck:tests`**. The third command is mandatory, because the other two do not check `satisfies` pins (2b final-review finding).

## Pre-registered decisions (cite in commits)

1. **3a's crosswalk core is Form 499 plus the BDC provider list. CORES arrives as a bounded enrichment pass (Task 9) rather than through the Nexus scraper.** _Revised 2026-07-31 after operator pushback. The first draft deferred CORES entirely. It reasoned from "the salvage has no bulk loader" to "no good source exists", which does not follow, and the conclusion was wrong._ Research found that the FCC publishes a documented **FRN API** (`data.fcc.gov/api/frn`, the "FRN Conversions" GetInfo call). It returns the company name **plus parent and subsidiary names**. A Relationship-FRN endpoint is also documented in Postman. This is a supported interface rather than an HTML scrape, and the parent/subsidiary fields make CORES a **family-edge source for 3b**, which is worth much more than the first draft's "enrichment" framing suggested.
   No CORES **bulk** extract was found, because the FCC's bulk downloads cover ULS and ASR but not CORES. Per-FRN calls are acceptable here because 499 and the provider list first produce a **finite, enumerated FRN universe**. The job is bounded enrichment over a known key set rather than an open-ended crawl for discovery. Cache per FRN, rate-limit the requests, and identify the client.
   **Blocked on verification:** `www.fcc.gov` and `data.fcc.gov` return 403 at the Akamai edge from the lab host, so the API's exact response shape, auth needs and terms are unverified. `broadbandmap.fcc.gov` works with credentials, so the block is specific to these hosts. Task 9 opens with a verification step and stops if the interface differs from the documentation.
2. **`filer.db` is not a layer-interface artifact in 3a.** It has no coordinates (ASR is 3c), and `layer_coverage` is h3-keyed with no null path. Conforming would mean writing coverage rows that assert no fact. The meaning-of-zero rule prohibits such rows. 3a ships its own `filer_manifest` table (name, version, source, source_vintage, build_cmd, build_sha, created_at), with `LayerManifestTable`'s fields minus the spatial ones. Layer-interface conformance is deferred to 3c, when ASR structures provide coordinates and coverage becomes meaningful. **Do not geocode filer HQ addresses in 3a** to create a spatial spine.
3. **FRN is a zero-padded 10-character branded string.** Nexus types it as `Tagged<number>`, while `BDCProviderTable.frn` is already `string | null`. Numeric storage loses leading zeros, the same defect class as 2a's `location_id`. Provide `isFRN(value): value is FRN` with a real 10-digit check, which the Nexus guard lacks.
4. **Clustering runs with `learnedScorer: false`.** `resolveEntities` defaults to a GBT model trained on **NPPES healthcare dedup**, and its threshold is not in Fellegi-Sunter weight units. Corporate-name linkage needs the direct FS path the spec describes. Revisit this only with a model trained on corporate data.
5. **Authoritative and inferred edges never merge.** Entity clusters are connected components over **authoritative edges only**. Inferred edges are stored with their scores and can be queried, but a rollup that includes them must say so. This is §4.1, and it is an acceptance check.
6. **The graph keeps full cardinality, and `bdc_provider` is an explicitly lossy denormalization.** A `provider_id` can carry multiple FRNs and conflicting holding companies. Nexus warns, overwrites and keeps the last value, and this code must not copy that. `filer.db` retains every edge. When task 8 populates `bdc_provider`, the primary FRN is the one from the most recent 499 filing date, and the schema docstring documents that rule. `brand_name` stays NULL because the provider list has no source for it.
7. **Temporal validity: `valid_from` is mandatory and `valid_to` is nullable.** In 3a the only date source is the 499 `lastFiledAt`. `valid_from` is therefore the filing date for 499-derived edges and the file vintage for provider-list edges. Transfer-of-control dates arrive in 3b. Every rollup query takes an `asOf` date.
8. **Parse by streaming rather than reading whole files.** The Nexus 499 loader reads the entire TSV into memory and silently truncates short rows (`relax_column_count_less`). The new parser streams, and a short row raises an error that identifies the file and line. Malformed input is never silently absorbed, as with 2a's `peekProviderID`.

## Acceptance checks (§7-3a, pre-registered — Task 7 discharges them)

1. **Provenance completeness (required).** No edge can exist without `source`, `source_vintage`, `assertion` and `valid_from`. Enforce this structurally. The fields are non-optional on the insert type and pinned with `satisfies Record<keyof FilerEdgeInsert, true>`, and a runtime test asserts that a partial edge is rejected.
2. **Authoritative and inferred edges are never conflated.** Clustering uses authoritative edges only. A test builds a fixture where an inferred edge _would_ merge two authoritative components, and it asserts that the merge does not happen and that the API exposes the distinction.
3. **Cardinality fidelity.** A fixture `provider_id` carrying two FRNs round-trips both edges through `filer.db`. The test also asserts that the documented primary-FRN rule picks the later-filed one.
4. **Temporal scoping.** Every edge carries `valid_from`. A rollup query with an `asOf` before an edge's `valid_from` excludes that edge, and the result states the `asOf` it used.

---

### Task 1: `@mailwoman/filer` workspace skeleton

**Files:** Create `filer/{package.json,tsconfig.json,tsconfig.test.json,index.ts,README.md}`, `filer/sdk/index.ts`. Modify root `package.json` workspaces + root `tsconfig.json` references.

**Produces:** importable empty `@mailwoman/filer` + `@mailwoman/filer/sdk`.

- [x] Copy `bdc/package.json` shape exactly (name `@mailwoman/filer`, same license/engines/exports incl. the dev `node → .ts` condition, `files` array). Deps: `@mailwoman/core`, `@mailwoman/record`, `@mailwoman/registry`, `@mailwoman/match` as `workspace:*`, `kysely ^0.29.4`, `type-fest`. Mirror `bdc/tsconfig.json` with references to those.
- [x] `filer/index.ts` re-exports `./sdk/index.ts` and (later) `./schema.ts`. README: what it is, spec pointer, and the decision-2 sentence (not a layer-interface artifact in 3a, and why).
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
- [x] Implement. Retain both the `managementCompany` and `holdingCompany` fields, because they are different assertions (spec §3.1 finding 1). Note in the docstring that `otherTradeName1` exists in the Nexus interface but not its column tuple, and is therefore absent here by design.
- [x] Commit `feat(filer): FRN branded string + streaming Form 499 parser (3a task 2, decisions 3,8)`.

### Task 3: BDC provider list parsing

**Files:** Create `filer/sdk/provider-list.ts` + test + a fixture CSV.

**Produces:**

```ts
export interface ProviderListRow { providerID: number; frn: FRN; holdingCompany: string | null }
export async function* parseProviderList(csvPath: string): AsyncIterable<ProviderListRow>
```

One `provider_id` may appear on multiple rows with different FRNs. **Yield every row**, without deduplicating or keeping only the last one (decision 6). The fixture must include a provider_id with two FRNs and one with two different holding-company strings.

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
	valid_from: string // MANDATORY (decision 7, check 4)
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

The edge PK is `(from_node_id, to_node_id, source, valid_from)`. The same relationship asserted by two sources or two vintages is therefore stored as two rows, and neither overwrites the other.

- [x] TDD: use an in-memory DatabaseClient, create all tables, round-trip a typed edge, and enforce a single manifest row. Copy `readLayerManifest`, which throws unless exactly one row exists.
- [x] Commit `feat(filer): filer.db schema — provenanced time-scoped crosswalk (3a task 4, decisions 2,7)`.

### Task 5: The builder

**Files:** Create `filer/sdk/build-filer.ts` + test. Copy `bdc/sdk/build-bdc.ts`'s flow verbatim: `${out}.building` → pragmas → shared handle (`DatabaseClient` for DDL, raw prepared statements for hot inserts) → stage-table dedup via composite-PK `INSERT OR IGNORE` → materialize → index-after-load → manifest → `ANALYZE`/`VACUUM` → `sealDatabase` → rename old to `.prev` → rename into place. Also copy the `asschemadb`-style Kysely invariance cast if needed.

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

The builder emits these authoritative edges: FRN↔form499ID, FRN↔holdingCompanyName, FRN↔managementCompanyName (both company fields, per the decision), bdcProviderID↔FRN and bdcProviderID↔holdingCompanyName. It stores legal name, DBA, classifications and contact fields as attributes. `valid_from` follows decision 7.

- [x] TDD through the rows boundaries, with no file IO in tests. Assert that a malformed row raises an error, that a provider_id with two FRNs yields two edges, that every edge has non-empty provenance, and that the manifest carries the vintage.
- [x] Commit `feat(filer): filer.db builder — authoritative edges, staged dedup, sealed artifact (3a task 5)`.

### Task 6: Entity clustering

**Files:** Create `filer/sdk/cluster-filers.ts` + test.

Clustering runs in two passes:

- (a) **Authoritative components.** Feed authoritative edges to `cluster()` from `@mailwoman/match` (`match/clustering.ts:112`) as `ScoredLink`s with `weight: Infinity`, and write `filer_cluster` rows with `assertion: "authoritative"`.
- (b) **Inferred links.** Build `SourceRecord`s (`registry/types.ts:15`) from filer nodes. Set `organization` to the canonicalized legal name (`record/organization.ts` `canonicalizeOrganizationName`), `address` to the HQ, and `attributes` to FRN/form499ID/providerID as code-set strings. Then call `resolveEntities(records, { exactDiscriminators: [...], learnedScorer: false })` (decision 4), and write the resulting links as `assertion: "inferred"` edges with their scores.

**Inferred links never modify authoritative cluster assignments** (decision 5, check 2).

- [x] TDD, including check 2's fixture of two authoritative components that an inferred edge would bridge. Assert that the authoritative clustering is unchanged and that the inferred edge is recorded separately.
- [x] Commit `feat(filer): authoritative clustering + inferred linkage, never conflated (3a task 6, decisions 4,5)`.

### Task 7: Readers, the four checks, and the `filer_lookup` MCP tool

**Files:** Create `filer/sdk/filer-lookup.ts` + test (the checks live here); modify `mcp/{tools.ts,cli.ts,layer-guards.ts,tools.test.ts,package.json,tsconfig.json}`.

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

The query requires exactly one identifier and throws otherwise, as `filingLandscape` does for its XOR inputs. `as_of` defaults to today and is always present in the result. The reader reads the manifest first and throws rather than returning an answer without a vintage stamp.

MCP: add `mailwoman_filer_lookup` following the house pattern exactly: snake_case zod with `.describe()` on every field, an `MCPToolDeps` method, and parse → deps → verbatim result. Add `openFilerDatabaseIfPresent`/`assertFilerDatabaseExists` in `mcp/layer-guards.ts`, following the 2b precedent.

- [x] **Write the check tests first, in a `describe("§7-3a checks")` block.** They are the four checks from this plan's Acceptance Checks section, verbatim, including check 1's structural pin (`satisfies Record<keyof FilerEdgeInsert, true>`) and a runtime rejection test.
- [x] Commit `feat(filer,mcp): filer_lookup reader, the four 3a checks, MCP tool (3a task 7)`.

### Task 8: Populate `bdc_provider` (cross-workspace)

**Files:** Modify `bdc/sdk/build-bdc.ts` (add `BuildBDCOptions.providers?`), `bdc/schema.ts` (docstring only, for the primary-FRN rule), `mailwoman/commands/gazetteer/build/bdc.tsx` (flag), and tests.

`bdc.db` is sealed and atomically swapped, so this is a **rebuild path** rather than an in-place write (recon finding 4). Add an optional `providers?: Iterable<ProviderListRow>` to `BuildBDCOptions`. When it is present, populate `bdc_provider` during the build. The primary FRN is the one from the most recent 499 filing date. `brand_name` stays NULL because no source provides it, and the docstring says so. Verify that the default path (no `providers`) produces output byte-identical to today's.

- [x] TDD. Assert that default-path behavior is unchanged and that a multi-FRN fixture exercises the lossy-denormalization rule.
- [x] Commit `feat(bdc): optional provider population during build (3a task 8, decision 6)`.

### Task 9: CORES enrichment via the documented FRN API — **STOPPED AT THE CHECK (2026-07-31), deferred to 3b**

**Step 0 outcome:** the stop check fired, and the task was not implemented. The lab host sent these probes with a User-Agent that identified the project and gave a contact address:

- `https://data.fcc.gov/api/frn/getInfo?frn=0001753557&format=json` returned **403 Access Denied** at the Akamai edge (`errors.edgesuite.net` reference). The identifying UA did not change the outcome, so the block depends on the host or IP rather than the agent string.
- `https://apps.fcc.gov/cores/api/frn/0001753557` returned an HTML **"Invalid Request"** page rather than JSON. That guessed path is not the documented interface.

The check's own terms read: _"if the host 403s from this machine, or the response does not carry the documented fields, STOP and report — do not fall back to the Nexus HTML scrape"_. No fallback was attempted, and no code was written. `broadbandmap.fcc.gov` still works with credentials, so the block is specific to these hosts rather than covering all FCC hosts.

**What remains true:** the FRN Conversions API is publicly documented and reportedly returns parent and subsidiary names, which would make it a family-edge source rather than only enrichment. No evidence disproved that claim. It could not be verified from the lab host.

**Carried to 3b** with two prerequisites:

1. Run Step 0 from a network path that can reach `data.fcc.gov`, such as the operator's own machine, and record the real response shape, auth requirements and terms.
2. Implement only after that, and keep the enumeration bounded. The FRN universe comes from the already-built crosswalk, so the job is enrichment over a known key set and never a crawl.

<details>
<summary>Original task specification (unimplemented, retained for 3b)</summary>

**Files:** Create `filer/sdk/cores.ts` + test. Modify `filer/sdk/build-filer.ts` to accept the enrichment as an optional input.

**Step 0 is a stop check.** Before writing anything, verify that the interface exists and behaves as documented. Call `data.fcc.gov/api/frn` (the FRN Conversions GetInfo call) for known FRNs: `0001753557` (WideOpenWest Finance, LLC, from the operator's field example) and `0003768165` (Comcast). Record the real response shape, whether parent/subsidiary names are present, whether auth is required, and any published rate limit or terms. **If the host 403s from this machine, or the response does not carry the documented fields, STOP and report — do not fall back to the Nexus HTML scrape, and do not proceed to the remaining steps.** The Akamai edge blocked the lab host on 2026-07-31. The operator may need to run this step, or it may work from a different network path.

**Produces (only if Step 0 passes):**

```ts
export interface CORESEntity { frn: FRN; entityName: string | null; parentName: string | null
  subsidiaryNames: string[]; entityType: string | null; retrievedAt: string }
export async function fetchCORESEntity(frn: FRN, opts?: { fetchImpl?: typeof fetch; cacheDir?: string }): Promise<CORESEntity | null>
export async function* enrichFromCORES(frns: Iterable<FRN>, opts?): AsyncIterable<CORESEntity>
```

The job is bounded by construction. The FRN set comes from the already-built crosswalk, so the code enumerates a known finite key set rather than crawling for discovery. Cache results on the filesystem per FRN, keyed by FRN and retrieval date. Send requests serially or with small concurrency, use a descriptive User-Agent, and pause between calls for a documented interval. Tests use a stub `fetchImpl`, and **the test suite makes no live network calls**.

The enrichment emits authoritative edges, since CORES states them: `frn ↔ parentName` and `frn ↔ subsidiaryName` (one edge per subsidiary), with `source: "cores"` and `source_vintage` set to the retrieval date. 3b builds its family edges on these.

- [x] Step 0 stop check: **fired. The task was not implemented and is deferred to 3b.**

</details>

### Task 10: Wrap-up

- [x] Run the full ladder, including `yarn typecheck:tests`, and tick the plan checkboxes. The controller handles the final review and PR, so do not open a PR in this task.

## Out of scope for 3a (do not build)

- Layer-interface conformance for filer.db (decision 2).
- Geocoding filer HQ addresses.
- SEC/EDGAR and corporate families (3b).
- ASR/ULS (3c).
- `competition(area)` (3d).
- Transfer-of-control edges (3b). The schema's `valid_from`/`valid_to` must still accept them without a migration.

## Self-review notes

- Spec §3.1 columns map to T2. Both family fields are retained. T2 does not emit the DC agent as a family edge, per the spec's anti-pattern warning.
- The §4.1 graph maps to T4/T5, and §4.1 clustering maps to T6.
- §6-3a `bdc_provider` maps to T8.
- Transaction-layer §2 `valid_from` maps to T4/T5, with room for 3b extensions.
- Types: `FRN` (T2) flows through T3/T4/T5/T7. `Form499Row` and `ProviderListRow` (T2/T3) feed `BuildFilerOptions` (T5). `FilerDatabase` (T4) feeds T5/T6/T7/T8.
