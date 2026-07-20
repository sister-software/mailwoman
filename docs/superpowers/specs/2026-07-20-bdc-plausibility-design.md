# BDC broadband-plausibility vertical (Phase 2) — design

2026-07-20. Operator + Claude. Extends
`docs/superpowers/specs/2026-07-18-spatial-layers-and-poi-design.md` (the Phase-1 spatial-layer
spec); its §7 decisions bind here — the layer contract, the shipped/build-local/private tiers,
the meaning-of-zero rule, "ship the builder, not ODbL data," the agent-as-decoder framing, and
the thin MCP toolset. Companion integration notes:
`scratchpad/poi-record-match-integration.md` (record/match seams for the provider registry and
CRM layers). Nexus salvage source surveyed read-only this session:
`/home/lab/Projects/isp-nexus/universe` (AGPL, operator is sole author, relicense-by-copy
approved per the Phase-1 salvage rule).

Phase 1 is substantially landed already: `core/layers/` (the contract), `@mailwoman/spatial/h3`
(the 48-bit packing), `resolver-wof-sqlite/poi-schema.ts` + `mailwoman/gazetteer-pipeline/poi/`
(poi.db), `@mailwoman/poi-taxonomy`, and `mcp/` (the thin tool surface) all exist in-tree. This
spec builds the BDC vertical on that substrate. It is a design, not a plan — each phase gets its
own plan file after review.

## 1. Problem + users

The question class is broadband-filing plausibility: an ISP or a consultant has a claim — "this
address has fiber at 1000/1000" or "this provider filed gigabit across this county" — and needs
to know whether the claim is physically and administratively plausible against public record and
local physical ground truth.

Users:

- **ISP filing teams** — preparing or auditing their own FCC BDC (Broadband Data Collection)
  filings; want to see what the filing landscape looks like around an address or area before they
  file or challenge.
- **Consultants** — grant/subsidy work, competitive analysis, market sizing against real address
  and housing counts.
- **Surveyors / CRM enrichment** — join a private book of buildings/customers against the public
  filing and demographic picture ("which of our buildings sit in a block a competitor claims to
  serve").

The interface is an **agent**, not a form. The agent supplies intent extraction, planning, and
narrative. Mailwoman supplies what the agent lacks: deterministic, local, provenance-tracked
spatial ground truth — the address spine, the layers, the distances, the census. This is the
Phase-1 framing applied to one vertical: mailwoman is the decoder's tool belt, never the
reasoner.

Mailwoman's specific angle, and its honesty boundary: it grades claims against **public record +
physics**, never against a proprietary map it cannot see (the CostQuest Fabric — §2.2). Positive
co-presence of physical plant near a claim is evidence; absence is never disproof (§4).

## 2. Data layers

Every layer is the Phase-1 artifact shape: a sealed 0444 SQLite database embedding
`layer_manifest` + `layer_coverage`, keyed on the shared spine (`h3` 48-bit short cell as an
**integer** at a declared resolution, `wof_id`, `address_id`), built-then-swapped, read through
`@mailwoman/core/layers`. poi.db is the worked precedent: it packs `h3_cell` as
`Number(BigInt("0x" + shortenH3Cell(cell)))` at `POI_H3_RESOLUTION` (res 9, matching
`ADDRESS_H3_RESOLUTION` in `@mailwoman/address-id`), so a POI↔address join is key equality.
**Every layer below packs h3 the same way** — integer res-9 short cell — so BDC, demographics,
and address-id all join without cell math.

### 2.1 bdc.db — FCC BDC filings (shipped tier candidate)

FCC BDC availability data is a US-government public-record dataset (public domain). It is the
per-provider, per-block, per-technology, per-speed claim of where broadband is available.

Row grain (verified against Nexus `sync/fcc/bdc/block-aggregator.ts:47`,
`CensusBlockAvailabilityRecord`):

| field                           | meaning                                                                    |
| ------------------------------- | -------------------------------------------------------------------------- |
| `provider_id`                   | FCC 6-digit provider id (`ProviderID`, Form-499 FRN-linked)                |
| `technology_code`               | BDC technology code 10–90 (xDSL, DOCSIS, fiber `50`, GSO/NGSO sat, …)       |
| `max_advertised_download_speed` | Mbps                                                                        |
| `max_advertised_upload_speed`   | Mbps                                                                        |
| `low_latency`                   | boolean                                                                     |
| `business_residential_code`     | B/R/both                                                                    |
| `geoid`                         | 15-char census block GEOID — the **public** spatial key                     |
| `location_id`                   | Fabric BSL id — opaque join key only (§2.2); NOT resolvable to a point by us |

**Spine keys.** `wof_id` (block-centroid PIP against the gazetteer at build time), `h3` (res-9
integer short cell of the block centroid). `address_id` is NOT a spine key here — BDC claims are
block-grained, not address-grained; the `location_id` (BSL) that would make them address-grained
is licensed and unresolvable (§2.2). This is a deliberate contract choice: bdc.db rows key at
block resolution, and any per-address answer is an inference across the block, flagged as such.

**Tier.** Shipped candidate — the source is public domain. Open cost, flagged (§7): a full
nationwide fixed-broadband availability vintage is ~10^8 rows. Shipping a continental bdc.db to
R2 is a size and build-time cost, not a licensing one. The likely resolution is a **shipped
pilot-state pocket + build-local for the rest**, mirroring the poi.db "pilot then scale"
posture; decide at 2a exit.

**Freshness / vintage.** BDC publishes on an `as_of_date` cadence (biannual — Nexus
`sync/fcc/bdc/filing-dates.ts` reads the `as_of_date` list from the public API). bdc.db is a
**snapshot** of one vintage: `freshness_policy = versioned-refresh` (re-issued under the same
name per vintage), each issue itself sealed. `source_vintage` carries the `as_of_date`;
`build_sha` + `build_cmd` pin the exact filing files. A filing landscape is only ever "as of
vintage X" — the vintage is load-bearing on every answer, not metadata.

**Meaning-of-zero.** `layer_coverage` at res 6 records which blocks the ingested vintage actually
covered. A block with no filing row is **UNKNOWN** — no provider filed availability there in this
vintage — never "no service exists." This is the whole epistemic spine of the vertical (§4):
absence of a filing is not evidence of absence of service, and never evidence of implausibility.

### 2.2 The CostQuest Fabric boundary — NEVER ingested

The BDC Fabric (the BSL id → precise rooftop point/parcel map) is **CostQuest-licensed**.
Mailwoman never ingests it, never ships it, never derives a table from it. Concretely:

- `location_id` (BSL) is carried in bdc.db only as an **opaque join key** — a string a licensed
  user could join against their own Fabric copy on their own disk. We store the id; we never
  store or infer its coordinate.
- All spatial work happens at **census-block granularity** (public GEOID) plus the address spine
  mailwoman already owns (situs points, gazetteer, address-id). Where a per-BSL answer would need
  the Fabric point, we return a block-level inference and say so.
- "Fabric-without-Fabric" (Nexus `sync/commands/bdc/infer-locations.ts`) is the salvage that
  matters here: infer location→block relationships from the free per-provider availability CSVs
  themselves, not from the licensed Fabric. It ports as a build-time **sqlite staging** step
  (the Nexus Redis dedup is replaced — §3).

This boundary is stated in the manifest `attribution` and in the vertical's docs. It is the
difference between a shippable public-record product and a license violation.

### 2.3 Infrastructure layers — build-local (ODbL)

Physical-plant evidence (fiber huts, telephone exchanges, telecom cabinets, datacenters) has no
permissive source. It lives in OSM and in Overture's _base_ theme, both ODbL. Per the Phase-1
tier rule and §3.5 of the Phase-1 spec, mailwoman **ships the builder, not the data**: the
existing `poi build --source osm` path (build-local layer over `osm/sdk` ingestion) is extended
to recognize telecom-infrastructure tags, and `@mailwoman/poi-taxonomy`'s
infrastructure-extension namespace gains the categories:

- `data_center` (already named in Phase-1 §3.5) — `man_made=data_center` / `telecom=data_center`.
- `telecom_exchange` — `man_made=telephone_exchange`, `telecom=exchange`.
- `telecom_cabinet` / `street_cabinet` — `man_made=street_cabinet` + `street_cabinet=telecom`.
- `tower_comms` — `man_made=mast` / `tower:type=communication` (coarse; low precision, flagged).

There is no separate `infra.db`: infrastructure classes are POI categories in the build-local OSM
layer, exactly as Phase-1 §3.5 established for `fire_hydrant`/`data_center`. When that layer is
absent, plausibility_check degrades to "requires the locally-built OSM infra layer" — the answer
names the missing layer, never fabricates a distance.

**Tier / freshness / meaning-of-zero.** `build-local`, `freshness_policy = sealed` (rebuild-only),
`layer_coverage` from the OSM survey extent. OSM telecom coverage is sparse and uneven — the
coverage table is not decoration here, it is what stops a sparse cell from reading as "no fiber
plant nearby, therefore implausible" (§4).

### 2.4 Demographics — reuse the existing tiger workspace (shipped)

Market sizing needs population, housing-unit, and area counts per census unit. **This already
exists in-tree** — `tiger/sdk/schema.ts` defines `TIGERBlockTable` (`population`,
`housing_unit_count`, `block_group_code`, `block_code`, land area) and `PLBlockTable` (2020 P.L.
94-171). The Nexus "TIGER block model with population/housing/area" salvage row is therefore
**mostly redundant** — do not re-port it; reuse `@mailwoman/tiger`. The only genuinely new piece
is exposing the block table as a demographics layer conforming to the layer contract (a thin
manifest/coverage wrapper + a res-9 h3 column), so `market_size` reads it through the same
`@mailwoman/core/layers` seam as everything else. Census is public domain — shipped tier, sealed.

### 2.5 Provider registry — versioned-refresh (2c)

The set of broadband providers (FRN, Form-499 identity, DBA names, corporate parent) is a
registry that changes over time. It ships as a `versioned-refresh` layer whose rows are
**organizations keyed by FRN**, joined to places via the record matcher (not a bespoke contacts
subsystem — see §5 and the integration notes). Deferred to 2c; named here so 2a's bdc.db carries
`provider_id` in a shape the registry can later join.

### 2.6 power.db — deferred, license-gated

Grid proximity (a real physical-plausibility signal for large plant) would come from HIFLD.
HIFLD layers have mixed licensing (some public, some access-restricted). Deferred to an open
question (§7); not in the 2a–2c scope.

## 3. Primitives / tools

Favor existing packages. The Phase-1 scope guard holds: verticals are agent workflows over the
spine, not new ML product lines. But BDC needs a **data-acquisition provider** (fetch, parse,
shard, ingest) exactly like `ban/` and `osm/`, so one new workspace is justified:

**`@mailwoman/bdc`** (new workspace, mirrors `ban`/`osm`): `bdc/sdk` (the public-API client,
file listing, vintage resolution, CSV parsing, ingest to the staging DB), the bdc.db Kysely
schema module (`createBDCTable` co-located with the typed interface, intersecting
`LayerContractDatabase`), the layer reader, and the thin plausibility scorer. Everything else
reuses existing packages.

The three primitives, and where each lives:

### 3.1 `filing_landscape(area)` → provider/tech/speed census

A census of the BDC filings in an area: which providers, which technologies, which advertised
speeds, over how many blocks. Pure composition — `aggregate(bdc.db, area, h3res)` (the Phase-1
`@mailwoman/spatial` verb) grouped by `provider_id` / `technology_code` / speed bucket. Lives as
a reader function in `@mailwoman/bdc`; the `area` is resolved by the existing geocode/gazetteer
path (a WOF id, a bbox, or an h3 cell set). Returns per the coverage rule: the census is scoped
to surveyed blocks, and unsurveyed blocks in the area are reported as unknown count, not zero.

### 3.2 `plausibility_check(address, claimed_tech, claimed_speed) → evidence bundle`

The headline primitive. Composition, no ML:

1. Geocode `address` (existing pipeline) → block `geoid` + res-9 `h3` cell.
2. **Filing evidence** — does bdc.db hold a filing in that block matching `claimed_tech` at or
   above `claimed_speed`? (positive corroboration) Or a filing that contradicts it (a provider
   filing a lesser tech)? (weak signal, not disproof).
3. **Physical evidence** — `nearest(osm-infra-layer, point, k)` for the plant class the claim
   implies (fiber claim → nearest telecom exchange / datacenter / cabinet). Distance + the
   coverage confidence of that cell.
4. Assemble `{ claim, evidence_found, coverage_confidence }` — never a bare score (§4). The
   bundle carries: the corroborating filing (if any) with its vintage, the nearest physical
   plant with distance and the cell's survey completeness, and an explicit
   `coverage_confidence` that degrades toward "insufficient survey data" as either layer's cell
   coverage thins.

Lives as `plausibility.ts` in `@mailwoman/bdc` — a thin scorer over the layer readers and the
`@mailwoman/spatial` verbs. It returns an evidence bundle; the agent writes the narrative.

### 3.3 `market_size(area, filters) → sized count`

Count of addressable units in an area matching filters (tech absent, speed below threshold,
single-provider blocks, …), sized against real counts. Composition of `aggregate()` over the
demographics layer (§2.4 — `housing_unit_count` / `population` from `@mailwoman/tiger`) filtered
by the bdc.db filing landscape (§3.1). Public proxy note (§7): housing-unit count is the public
denominator; the Fabric BSL count per block is licensed and not used. Lives as a reader
composition in `@mailwoman/bdc`, drawing on `@mailwoman/tiger`.

### 3.4 MCP surface

Three thin tools added to `mcp/tools.ts`, matching the existing schema+dispatch pattern
(`mailwoman_parse`, `mailwoman_poi_search`, `mailwoman_layer_manifest`):

- `mailwoman_bdc_filing_landscape`
- `mailwoman_plausibility_check`
- `mailwoman_market_size`

No logic in the tool layer — schema + dispatch over the `@mailwoman/bdc` readers, per the
Phase-1 MCP discipline. CLI + docs surfaces are thin fronts on the same readers; agents skip NL
entirely.

## 4. Registry-backed doctrine compliance — positive evidence only

This vertical is the sharpest test of the registry-backed doctrine
(`project-registry-backed-structured-prediction.md`) and the meaning-of-zero rule, because the
temptation to read absence as disproof is constant. The rules, pre-registered:

1. **Registries are soft priors and evidence, never verdicts.** A BDC filing present is positive
   evidence a provider *claims* service. It is not proof service exists (filings are
   self-reported and over-claim is the entire reason BDC challenges exist). The bundle reports
   "a filing corroborates the claim," never "the claim is true."
2. **Positive evidence only.** The only strong output is **co-presence**: a matching filing
   plus nearby physical plant in a well-surveyed cell. Everything else degrades toward
   uncertainty, not toward a negative verdict.
3. **Absence is UNKNOWN, not implausible.** No filing in a block → unknown (unsurveyed by that
   provider, or genuinely unserved — indistinguishable from the public record). No fiber plant
   within range → unknown *unless* the infra cell is well-surveyed, and even then it is
   "no corroborating plant found," not "impossible." The meaning-of-zero rule applies to
   **conclusions**, not just to storage: `plausibility_check` never emits "implausible" from an
   absence. The strongest negative it can emit is "no supporting evidence found, and coverage is
   good enough that this is informative" — still framed as absence-of-evidence.
4. **coverage_confidence is mandatory on every answer.** A sparse-coverage cell collapses the
   bundle to "insufficient survey data," which is a legitimate output — the product's honesty is
   this refusal to guess.

The physical-plausibility angle is a **falsifier that only fires positively**: physics can raise
confidence (plant is co-present) but a sparse-survey absence of plant cannot lower a claim below
"unknown." This is deliberate and is what keeps the vertical defensible.

## 5. Nexus salvage map (file-level)

Source: `/home/lab/Projects/isp-nexus/universe` (AGPL, relicense-by-copy). Salvage rule
(Phase-1 §7): copy files in, no provenance headers required, **never duplicate functionality
mailwoman already has**, re-home storage to Kysely/`node:sqlite`, merge into existing workspaces
where one exists.

### Ports

| Salvage                                                                                     | From (Nexus)                                                                              | Into                                                          |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Technology codes 10–90                                                                      | `fcc/bdc/technologies.ts`                                                                 | `@mailwoman/bdc` schema — **rewrite `enum`→const object** (§6) |
| BSL id branded type + predicate                                                             | `fcc/bdc/location.ts`                                                                     | `@mailwoman/bdc` (opaque join key only — §2.2)               |
| NTIA/BDC data dictionary (`NTIARecord`, `AddressConfidenceCode`, `LandUseCode`, `BSLFlag`)  | `fcc/bdc/data-collection.ts`                                                              | `@mailwoman/bdc` schema source (lift, `enum`→const)          |
| Provider id + FRN + Form-499 identity                                                        | `fcc/bdc/BroadbandProvider.ts`, `fcc/entity/frn.ts`, `fcc/entity/universal-service.ts`   | `@mailwoman/bdc` (2a) + provider registry (2c)               |
| Availability row shape (`CensusBlockAvailabilityRecord`)                                     | `sync/fcc/bdc/block-aggregator.ts`                                                        | bdc.db table schema (drop Parquet writer; ingest via DuckDB) |
| BDC public-API client (rate-limited, `broadbandmap.fcc.gov/api/public`)                      | `sync/fcc/bdc/client.ts`                                                                  | `bdc/sdk` — re-home env (`$private`→`core/env`) + lifecycle  |
| File listing + vintage/`as_of_date` resolution                                              | `sync/fcc/bdc/list-files.ts`, `filing-dates.ts`, `download-file.ts`, `path-builders.ts`  | `bdc/sdk` fetch path                                          |
| Byte-level CSV parser                                                                        | `sync/fcc/bdc/parsing.ts`                                                                 | `bdc/sdk` ingest                                             |
| Fabric-without-Fabric (location→block from free per-provider CSVs)                          | `sync/commands/bdc/infer-locations.ts`                                                    | `bdc/sdk` — **Redis dedup → sqlite staging** (§6)            |
| CORES scraper + Form-499 parser + entity classification                                     | `sync/fcc/CORESClient.ts`, `sync/fcc/universal-service.ts`                                | provider registry layer (2c)                                 |
| Organization / PointOfContact / OrganizationClassification models                           | Nexus `mailwoman/organization/*`, `mailwoman/contacts/PointOfContact.ts`                  | provider registry entity shell (2c) — see §5.1               |
| Block×availability×demographics rollup SQL                                                   | `sync/commands/bdc/generate-provider-geojson.ts`                                          | design reference for `aggregate()` / `market_size`           |

### Already ported — do NOT re-port

- **H3 48-bit short-cell packing** — `@mailwoman/spatial/h3` already exports `shortenH3Cell`,
  `expandH3Cell`, `shortCellToPoint`, `cellToPointLiteral` (Phase-1 landed it). Nexus stores the
  short cell as a hex string; mailwoman packs it to an **integer** for the clustered B-tree — use
  the mailwoman form, never the hex string.
- **TIGER block model with population/housing/area** — `@mailwoman/tiger` already has
  `TIGERBlockTable` + `PLBlockTable` (§2.4). Reuse it; the only new work is the layer-contract
  wrapper. (Block-intersection *queries* may be new; add them to `@mailwoman/tiger` or compose
  from `@mailwoman/spatial` — do not fork a second block model.)

### Does NOT port, and why

- **Fabric data-source / migrations** (`sync/fcc/fabric/*`) — CostQuest-licensed (§2.2). Never.
- **Redis** (dedup in `infer-locations.ts`, the `RedisManager`) — replaced by sqlite staging per
  house DB rules. No external service dependency in the ingest.
- **Parquet reader/writer** (`ParquetReader`/`ParquetWriter`) — the house pattern is DuckDB
  `read_parquet` into the SQLite output table (see `build-postal-city-alias.ts` precedent).
- **`@isp.nexus/core` lifecycle + `$private` env + yargs CLI** — re-home to mailwoman's
  `core/env` (zero-raw-`process.env` rule), the mailwoman async-init/lifecycle, and Pastel
  `cli-kit`. The `ServiceRepository.register` pattern in `client.ts` maps to the async-init
  package.
- **ECFS / ULS clients, CAF / RDOF / tribal ingest** — do not exist in Nexus; genuinely new work,
  deferred (subsidy registry is already Phase-1-deferred).

### 5.1 The contacts gap (from the integration notes)

Mailwoman has no contacts/organization *entity* today — `OrganizationName`
(`record/organization.ts`) is a name-canonicalization value object (no id, no FRN, no linked
places), and it explicitly defers acronym/DBA/TF-IDF org *matching* to "the matcher epic." The
Nexus `Organization` / `PointOfContact` / `OrganizationClassification` models supply the entity
shell; `@mailwoman/record` supplies the name normalization. Salvage rule: **do not duplicate
`OrganizationName`** — the provider registry becomes a versioned-refresh layer of
organizations-keyed-by-FRN, joined to places by the existing matcher, not a new subsystem. This
is 2c.

## 6. Named costs

- **`enum` → const object.** Every salvaged FCC dictionary type is a TS `enum`
  (`BroadbandTechnologyCode`, `AddressConfidenceCode`, `LandUseCode`, `BSLFlag`). `erasableSyntaxOnly`
  forbids `enum` repo-wide — each ports as `const X = {…} as const` + `type X = (typeof
  X)[keyof typeof X]`. Mechanical but touches every dictionary file.
- **Redis → sqlite staging** for the fabric-without-fabric dedup — a rewrite of the dedup pass,
  not a copy. The staging DB is a temp artifact, built-then-discarded.
- **bdc.db scale** — a nationwide fixed-broadband vintage is ~10^8 rows; continental shipped-tier
  is a real R2/build-time cost. Pilot-pocket-then-scale is the likely answer (decide at 2a exit).
- **BSL block-granularity ceiling** — because the Fabric point is licensed, every per-address
  plausibility answer is a block-level inference. This is a correctness ceiling, not a bug; the
  bundle must always flag block-grain inference as such.
- **OSM telecom sparsity** — telecom-infra coverage in OSM is thin and uneven; the physical
  falsifier fires positively far less often than the filing evidence, and the coverage table
  carries the weight of not over-reading its absence.

## 7. Phasing

Agent-night sizing per house convention (no calendar). Each phase gets its own plan file after
this spec is reviewed.

### 2a — bdc.db + `filing_landscape` (~3–4 agent-nights)

Scope: the `@mailwoman/bdc` workspace skeleton; salvage the BDC client + vintage/file listing +
CSV parser (`enum`→const, env re-home); the bdc.db Kysely schema intersecting
`LayerContractDatabase`; the fabric-without-fabric ingest (Redis→sqlite staging) for one pilot
state; the layer reader + `filing_landscape`; the `mailwoman_bdc_filing_landscape` MCP tool.

Gates (pre-registered):
- Layer-contract conformance — `readLayerManifest`/`readLayerCoverage` pass; h3 packed as res-9
  integer short cell (byte-compatible with poi.db / address-id join).
- Coverage/meaning-of-zero test — an unsurveyed block returns `undefined` from
  `readLayerCoverage`, and `filing_landscape` reports it as unknown, never zero.
- `filing_landscape` returns the correct provider/tech/speed census for a known block against a
  hand-verified BDC fixture (fixtures→smoke→full ladder, per the poi.db runbook).
- Vintage is stamped on every answer (`source_vintage` = `as_of_date`) and surfaced by the tool.

### 2b — `plausibility_check` + infra builders (~2–3 agent-nights)

Scope: telecom-infra categories in `@mailwoman/poi-taxonomy` (infrastructure-extension
namespace); `poi build --source osm` recognizes the telecom tags (build-local layer, nothing
ODbL shipped); the `plausibility.ts` scorer composing filing evidence + `nearest()` physical
evidence into the `{ claim, evidence_found, coverage_confidence }` bundle; the
`mailwoman_plausibility_check` MCP tool.

Gates:
- **Positive-evidence-only invariant test** — a fixture with a claim in a block that has NO
  filing and NO nearby plant returns "unknown / insufficient evidence," and asserts the scorer
  can NEVER emit "implausible" from an absence (§4). This is the load-bearing gate.
- Co-presence path — a claim with a matching filing + nearby well-surveyed plant returns high
  `evidence_found` + high `coverage_confidence`.
- Layer-absent path — with the OSM infra layer absent, the bundle says "requires the
  locally-built OSM infra layer," never a fabricated distance.
- Block-grain flag present on every per-address answer.

### 2c — provider registry + CRM via record/match (~3 agent-nights)

Scope: salvage CORES/Form-499 + the `Organization`/`PointOfContact` entity shell; the provider
registry as a `versioned-refresh` layer (organizations keyed by FRN); wire provider↔place through
the existing matcher (`HierarchyNode.placeID` as a blocking key, FRN as an `exactDiscriminator`,
brand/DBA as scored `nameSimilarity` — per the integration notes); the private-CRM-layer path
and `reconcile.ts` buckets ("our building in a competitor-claimed-served block").

Gates:
- Provider registry conforms to the layer contract (versioned-refresh, FRN-keyed).
- No duplication of `OrganizationName` — the matcher, not a new contacts subsystem, does the
  join (reviewer check against §5.1).
- A reconcile fixture produces the enrolled / present-not-in-base buckets over a synthetic
  CRM + bdc.db pair.
- Private-tier CRM layer loads from `$MAILWOMAN_DATA_ROOT` and never leaves the machine.

## 8. Open questions (for operator / counsel)

1. **CostQuest Fabric boundary** — confirm with counsel that carrying the BSL `location_id` as an
   opaque join key (no coordinate, no derived table) is clear of the Fabric license. §2.2 is
   written to that assumption; it gates 2a.
2. **bdc.db distribution** — shipped continental (~10^8 rows, R2 cost) vs. shipped pilot-pocket +
   build-local for the rest? Decide at 2a exit; affects the manifest tier and the build CLI.
3. **Which states first?** BDC is US-only (FCC). poi.db piloted CA for the demo probes — does BDC
   pilot CA too (demo alignment) or a target market state (product pull)?
4. **BDC vintage cadence + refresh discipline** — confirm biannual `as_of_date` cadence and who
   owns re-issuing bdc.db per vintage (the `versioned-refresh` curator question).
5. **HIFLD power.db** — is the grid layer we'd want public-domain or access-restricted? Gates
   whether §2.6 ever leaves deferred.
6. **OSM telecom infra ODbL** — same counsel sign-off as the unpublished `osm/` workspace; the
   build-local infra builder ships, but confirm the posture is identical.
7. **Market-size denominator** — confirm TIGER `housing_unit_count` is an acceptable public proxy
   for the addressable-unit count (the Fabric BSL count per block being licensed and unusable).
8. **Provider registry (CORES/Form-499)** — freshness cadence and curator ownership for 2c.
