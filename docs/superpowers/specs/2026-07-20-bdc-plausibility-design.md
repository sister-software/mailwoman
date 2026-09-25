# BDC broadband-plausibility vertical (Phase 2) — design

2026-07-20. Operator + Claude. **Reworked 2026-07-30** after the operator called it "way old". The design
did not change, and §0 records what changed around it in those ten days. Phase sizing and §8's counsel checks are unchanged.
This spec extends `docs/superpowers/specs/2026-07-18-spatial-layers-and-poi-design.md` (the Phase-1 spatial-layer
spec), and that spec's §7 decisions apply here: the layer interface, the shipped/build-local/private tiers,
the meaning-of-zero rule, "ship the builder rather than ODbL data," the agent-as-decoder framing, and
the thin MCP toolset. Companion integration notes are in
`scratchpad/poi-record-match-integration.md` (record/match boundaries for the provider registry and
CRM layers). This session surveyed the Nexus salvage source read-only:
`/home/lab/Projects/isp-nexus/universe` (AGPL). The operator is its sole author and approved relicensing by copy
under the Phase-1 salvage rule.

Most of Phase 1 has landed. `core/layers/` (the interface), `@mailwoman/spatial/h3`
(the 48-bit packing), `resolver-wof-sqlite/poi-schema.ts` + `mailwoman/gazetteer-pipeline/poi/`
(poi.db), `@mailwoman/poi-taxonomy`, and `mcp/` (the thin tool surface) all exist in-tree. This
spec builds the BDC vertical on top of them. It is a design and not a plan. Each phase gets its
own plan file after review.

## 0. The 2026-07-30 rework — what changed around this design

The changes below leave every §7 phase and every §2 layer decision intact. They concern the underlying code and the go-to-market (GTM) plan:

- **v8.2.0 shipped** (model 6.7.0-bundle: the evidence channels, the `inputMode` register surface,
  the retry rider). For BDC, `plausibility_check`'s geocode step handles customer-record
  addresses in the **formatted register** (`input_mode: "formatted"`, the `/v1/batch` default), and
  the zero-hit retry rider covers inverted records at no extra cost. §3.2 step 1 now states this. The
  bundle also improves the fragment path that consultants use interactively (map-box lookups).
- **GTM resequencing and platform discovery landed** (task file, 2026-07-28). The C-track order is
  confirmed, with C1→C4 before the Addok head-to-head. D4 found that **none of the five ISP platforms
  has a validation vendor**. Sonar (385+ ISPs, partner directory) is the commercial flagship
  target, UISP is the free-plugin distribution channel, and C5 (serviceability SaaS) is the live OEM
  reference. §1's users are therefore named routes to market as well as personas.
- **Counsel batching**: §8's eight questions go to the one consolidated G1 session, together with the
  license-fence, OEM-template, and ODbL items. Question 1 (the Fabric `location_id` join key)
  still blocks 2a. Only its scheduling changed.
- **The enterprise line** (ROAD_TO_MAILWOMAN_V8_3_0 / B11): 2c's CRM record-match work also serves as
  an enterprise on-ramp. The acceptance-battery practice from the retrain arc (per-customer
  canaries, noise-direct margins) applies unchanged to record-match delivery. The design does not change,
  but 2c should be scoped with that reuse in mind.
- **C1 is unblocked.** It was deferred on 2026-07-28 while the 8.2.0 arc occupied the repo, and the repo is
  now free.

## 1. Problem + users

The questions concern broadband-filing plausibility. An ISP or a consultant has a claim, such as "this
address has fiber at 1000/1000" or "this provider filed gigabit across this county", and needs
to know whether the claim is physically and administratively plausible against the public record and
local physical ground truth.

Users:

- **ISP filing teams** prepare or audit their own FCC BDC (Broadband Data Collection)
  filings. They want to see the filings around an address or area before they
  file or challenge.
- **Consultants** do grant/subsidy work, competitive analysis, and market sizing against real address
  and housing counts.
- **Surveyors and CRM enrichment users** join a private book of buildings or customers against the public
  filing and demographic data ("which of our buildings sit in a block a competitor claims to
  serve").

The interface is an **agent** instead of a form. The agent supplies intent extraction, planning, and
narrative. Mailwoman supplies what the agent lacks: deterministic, local, provenance-tracked
spatial ground truth in the form of the address spine, the layers, the distances, and the census. This applies the
Phase-1 framing to one vertical. Mailwoman provides the tools the agent calls and does no
reasoning of its own.

Mailwoman grades claims against **public record +
physics**, and never against a proprietary map it cannot see (the CostQuest Fabric, §2.2). Physical plant
present near a claim counts as evidence, and its absence never disproves the claim (§4).

## 2. Data layers

Every layer has the Phase-1 artifact shape. It is a sealed 0444 SQLite database that embeds
`layer_manifest` + `layer_coverage` and is keyed on the shared spine (`h3` 48-bit short cell as an
**integer** at a declared resolution, `wof_id`, `address_id`). It is built and then swapped into place, and it is read through
`@mailwoman/core/layers`. poi.db is the existing example. It packs `h3_cell` as
`Number(BigInt("0x" + shortenH3Cell(cell)))` at `POI_H3_RESOLUTION` (res 9, matching
`ADDRESS_H3_RESOLUTION` in `@mailwoman/address-id`), so a POI↔address join is key equality.
**Every layer below packs h3 the same way**, as an integer res-9 short cell, so BDC, demographics,
and address-id all join without cell math.

### 2.1 bdc.db — FCC BDC filings (shipped tier candidate)

FCC BDC availability data is a US-government public-record dataset (public domain). It records
where each provider claims broadband is available, per block, technology, and speed.

Row grain (verified against Nexus `sync/fcc/bdc/block-aggregator.ts:47`,
`CensusBlockAvailabilityRecord`):

| field                           | meaning                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `provider_id`                   | FCC 6-digit provider id (`ProviderID`, Form-499 FRN-linked)                  |
| `technology_code`               | BDC technology code 10–90 (xDSL, DOCSIS, fiber `50`, GSO/NGSO sat, …)        |
| `max_advertised_download_speed` | Mbps                                                                         |
| `max_advertised_upload_speed`   | Mbps                                                                         |
| `low_latency`                   | boolean                                                                      |
| `business_residential_code`     | B/R/both                                                                     |
| `geoid`                         | 15-char census block GEOID — the **public** spatial key                      |
| `location_id`                   | Fabric BSL id — opaque join key only (§2.2); not resolvable to a point by us |

**Spine keys.** `wof_id` comes from a block-centroid PIP against the gazetteer at build time, and `h3` is the res-9
integer short cell of the block centroid. `address_id` is not a spine key here, because BDC claims are
block-grained. The `location_id` (BSL) that would make them address-grained
is licensed and cannot be resolved (§2.2). This interface choice is deliberate. bdc.db rows key at
block resolution, and any per-address answer is an inference across the block that is flagged as one.

**Tier.** This is a shipped-tier candidate, because the source is public domain. One cost is still open (§7): a full
nationwide fixed-broadband availability vintage is ~10^8 rows. Shipping a continental bdc.db to
R2 costs size and build time, and it raises no licensing issue. The likely answer is a **shipped
pilot-state pocket + build-local for the rest**, following the poi.db "pilot then scale"
approach. Decide at 2a exit.

**Freshness / vintage.** BDC publishes on an `as_of_date` cadence, twice a year. Nexus
`sync/fcc/bdc/filing-dates.ts` reads the `as_of_date` list from the public API. bdc.db is a
**snapshot** of one vintage with `freshness_policy = versioned-refresh`: it is re-issued under the same
name for each vintage, and each issue is sealed. `source_vintage` carries the `as_of_date`, and
`build_sha` + `build_cmd` pin the exact filing files. Every statement about filings holds only "as of
vintage X", so every answer must include the vintage.

**Meaning of zero.** `layer_coverage` at res 6 records which blocks the ingested vintage
covered. A block without a filing row is **unknown**. It means no provider filed availability there in this
vintage and never means "no service exists." The whole vertical rests on this rule (§4):
a missing filing is not evidence that service is missing, and it is never evidence of implausibility.

### 2.2 The CostQuest Fabric boundary — NEVER ingested

The BDC Fabric (the map from BSL id to a precise rooftop point or parcel) is **CostQuest-licensed**.
Mailwoman never ingests it, never ships it, and never derives a table from it. Concretely:

- bdc.db carries `location_id` (BSL) only as an **opaque join key**. A licensed
  user could join this string against their own Fabric copy on their own disk. We store the id and never
  store or infer its coordinate.
- All spatial work happens at **census-block granularity** (public GEOID) plus the address spine
  mailwoman already owns (situs points, gazetteer, address-id). Where a per-BSL answer would need
  the Fabric point, we return a block-level inference and say so.
- The most useful salvage here is "Fabric-without-Fabric" (Nexus `sync/commands/bdc/infer-locations.ts`).
  It infers location→block relationships from the free per-provider availability CSVs
  themselves instead of the licensed Fabric. It ports as a build-time **sqlite staging** step
  that replaces the Nexus Redis dedup (§3).

The manifest `attribution` and the vertical's docs both state this boundary. Respecting it keeps the
product a shippable public-record product and keeps it clear of a license violation.

### 2.3 Infrastructure layers — build-local (ODbL)

Physical-plant evidence (fiber huts, telephone exchanges, telecom cabinets, datacenters) has no
permissive source. It exists only in OSM and in Overture's _base_ theme, and both are ODbL. Under the Phase-1
tier rule and §3.5 of the Phase-1 spec, mailwoman **ships the builder rather than the data**. The
existing `poi build --source osm` path (a build-local layer over `osm/sdk` ingestion) is extended
to recognize telecom-infrastructure tags, and the infrastructure-extension namespace of
`@mailwoman/poi-taxonomy` gains these categories:

- `data_center` (already listed in Phase-1 §3.5): `man_made=data_center` / `telecom=data_center`.
- `telecom_exchange`: `man_made=telephone_exchange`, `telecom=exchange`.
- `telecom_cabinet` / `street_cabinet`: `man_made=street_cabinet` + `street_cabinet=telecom`.
- `tower_comms`: `man_made=mast` / `tower:type=communication`. This class is coarse and low-precision, and answers flag it.

There is no separate `infra.db`. Infrastructure classes are POI categories in the build-local OSM
layer, as Phase-1 §3.5 established for `fire_hydrant`/`data_center`. When that layer is
absent, plausibility_check returns "requires the locally-built OSM infra layer". The answer
identifies the missing layer and never makes up a distance.

**Tier, freshness, and meaning of zero.** The layer is `build-local` with `freshness_policy = sealed` (rebuild-only),
and its `layer_coverage` comes from the OSM survey extent. OSM telecom coverage is sparse and uneven. The
coverage table keeps a sparsely surveyed cell from being read as "no fiber
plant near, therefore implausible" (§4).

### 2.4 Demographics — reuse the existing tiger workspace (shipped)

Market sizing needs population, housing-unit, and area counts per census unit. **These counts already
exist in-tree.** `tiger/sdk/schema.ts` defines `TIGERBlockTable` (`population`,
`housing_unit_count`, `block_group_code`, `block_code`, land area) and `PLBlockTable` (2020 P.L.
94-171). The Nexus "TIGER block model with population/housing/area" salvage row is therefore
**mostly redundant**. Do not re-port it, and reuse `@mailwoman/tiger` instead. The only new piece
exposes the block table as a demographics layer that conforms to the layer interface (a thin
manifest/coverage wrapper + a res-9 h3 column). `market_size` then reads it through the same
`@mailwoman/core/layers` boundary as every other layer. Census data is public domain, so this layer is shipped tier and sealed.

### 2.5 Provider registry — versioned-refresh (2c)

The set of broadband providers (FRN, Form-499 identity, DBA names, corporate parent) is a
registry that changes over time. It ships as a `versioned-refresh` layer whose rows are
**organizations keyed by FRN**. The record matcher joins them to places, and no bespoke contacts
subsystem is built (see §5 and the integration notes). The registry is deferred to 2c. It is described here so that 2a's bdc.db carries
`provider_id` in a shape the registry can join later.

### 2.6 power.db — deferred, license-conditional

Grid proximity would come from HIFLD. It is a real physical-plausibility signal for large plant.
HIFLD layers have mixed licensing: some are public and some are access-restricted. The layer is deferred as an open
question (§7) and is outside the 2a–2c scope.

## 3. Primitives / tools

Prefer existing packages. Verticals are agent workflows over the
spine and do not become new ML product lines. BDC does need a **data-acquisition provider** (fetch, parse,
extract, ingest) like `ban/` and `osm/`, so one new workspace is justified:

**`@mailwoman/bdc`** (new workspace, modeled on `ban`/`osm`) holds `bdc/sdk` (the public-API client,
file listing, vintage resolution, CSV parsing, ingest to the staging DB), the bdc.db Kysely
schema module (`createBDCTable` co-located with the typed interface, intersecting
`layerschemadatabase`), the layer reader, and the thin plausibility scorer. Everything else
reuses existing packages.

The three primitives, and where each lives:

### 3.1 `filing_landscape(area)` → provider/tech/speed census

This primitive counts the BDC filings in an area: which providers, which technologies, and which advertised
speeds, and over what number of blocks. It is a pure composition of `aggregate(bdc.db, area, h3res)` (the Phase-1
`@mailwoman/spatial` verb) grouped by `provider_id` / `technology_code` / speed bucket. It lives as
a reader function in `@mailwoman/bdc`. The existing geocode/gazetteer
path resolves the `area` to a WOF id, a bbox, or an h3 cell set. The result follows the coverage rule. The census covers
surveyed blocks only, and it reports unsurveyed blocks in the area as an unknown count instead of zero.

### 3.2 `plausibility_check(address, claimed_tech, claimed_speed) → evidence bundle`

This is the main primitive. It composes existing parts and uses no ML:

1. Geocode `address` with the existing pipeline in the **formatted register** for customer records (`input_mode: "formatted"`, the batch default, with the retry rider on zero-hit). The result is a block `geoid` + res-9 `h3` cell.
2. **Filing evidence**: check whether bdc.db holds a filing in that block that matches `claimed_tech` at or
   above `claimed_speed`, which corroborates the claim. A filing that contradicts it, such as a provider
   filing a lesser technology, is a weak signal and does not disprove the claim.
3. **Physical evidence**: run `nearest(osm-infra-layer, point, k)` for the plant class the claim
   implies (fiber claim → nearest telecom exchange / datacenter / cabinet). Record the distance and the
   coverage confidence of that cell.
4. Assemble `{ claim, evidence_found, coverage_confidence }`, and never a bare score (§4). The
   bundle carries the corroborating filing (if any) with its vintage, the nearest physical
   plant with its distance and the cell's survey completeness, and an explicit
   `coverage_confidence` that degrades toward "insufficient survey data" as the cell
   coverage of either layer thins.

It lives as `plausibility.ts` in `@mailwoman/bdc`, a thin scorer over the layer readers and the
`@mailwoman/spatial` verbs. It returns an evidence bundle, and the agent writes the narrative.

### 3.3 `market_size(area, filters) → sized count`

This primitive counts the addressable units in an area that match filters (tech absent, speed below threshold,
single-provider blocks, …), sized against real counts. It composes `aggregate()` over the
demographics layer (§2.4: `housing_unit_count` / `population` from `@mailwoman/tiger`), filtered
by the bdc.db filing landscape (§3.1). Housing-unit count is the public
denominator (§7). The Fabric BSL count per block is licensed and is not used. The primitive lives as a reader
composition in `@mailwoman/bdc` that draws on `@mailwoman/tiger`.

### 3.4 MCP surface

Three thin tools are added to `mcp/tools.ts`, following the existing schema+dispatch pattern
(`mailwoman_parse`, `mailwoman_poi_search`, `mailwoman_layer_manifest`):

- `mailwoman_bdc_filing_landscape`
- `mailwoman_plausibility_check`
- `mailwoman_market_size`

The tool layer holds no logic. It only declares schemas and dispatches to the `@mailwoman/bdc` readers, as the
Phase-1 MCP design requires. CLI and docs surfaces are thin fronts on the same readers, and agents skip natural language
entirely.

## 4. Registry-backed doctrine compliance — positive evidence only

This vertical tests the registry-backed doctrine
(`project-registry-backed-structured-prediction.md`) and the meaning-of-zero rule harder than any other, because
reading absence as disproof is a constant temptation. The pre-registered rules are:

1. **Registries are soft priors and evidence, never verdicts.** A BDC filing is positive
   evidence that a provider _claims_ service. It does not prove that service exists. Filings are
   self-reported, and over-claiming is the reason BDC challenges exist. The bundle reports
   "a filing corroborates the claim," never "the claim is true."
2. **Positive evidence only.** The only strong output is **co-presence**: a matching filing
   plus physical plant close by in a well-surveyed cell. Every other result degrades toward
   uncertainty instead of toward a negative verdict.
3. **Absence means unknown rather than implausible.** A block without a filing → unknown. The provider may not have surveyed it,
   or it may be unserved, and the public record cannot tell these apart. No fiber plant
   within range → unknown _unless_ the infra cell is well-surveyed. Even then the answer is
   "no corroborating plant found," and never "impossible." The meaning-of-zero rule applies to
   **conclusions** rather than to storage: `plausibility_check` never emits "implausible" from an
   absence. The strongest negative it can emit is "no supporting evidence found, and coverage is
   good enough that this is informative", which still reports a lack of evidence.
4. **coverage_confidence is mandatory on every answer.** A sparse-coverage cell reduces the
   bundle to "insufficient survey data," and that is a legitimate output. The product
   refuses to guess.

The physical-plausibility check can only raise confidence. Co-present plant raises a claim's
confidence, but a sparse-survey absence of plant cannot lower a claim below
"unknown." This asymmetry is deliberate, and it keeps the vertical defensible.

## 5. Nexus salvage map (file-level)

Source: `/home/lab/Projects/isp-nexus/universe` (AGPL, relicense-by-copy). The salvage rule
(Phase-1 §7) is to copy files in without provenance headers, **never duplicate functionality
mailwoman already has**, move storage to Kysely/`node:sqlite`, and merge into an existing workspace
wherever one exists.

### Ports

| Salvage                                                                                    | From (Nexus)                                                                            | Into                                                           |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Technology codes 10–90                                                                     | `fcc/bdc/technologies.ts`                                                               | `@mailwoman/bdc` schema — **rewrite `enum`→const object** (§6) |
| BSL id branded type + predicate                                                            | `fcc/bdc/location.ts`                                                                   | `@mailwoman/bdc` (opaque join key only — §2.2)                 |
| NTIA/BDC data dictionary (`NTIARecord`, `AddressConfidenceCode`, `LandUseCode`, `BSLFlag`) | `fcc/bdc/data-collection.ts`                                                            | `@mailwoman/bdc` schema source (lift, `enum`→const)            |
| Provider id + FRN + Form-499 identity                                                      | `fcc/bdc/BroadbandProvider.ts`, `fcc/entity/frn.ts`, `fcc/entity/universal-service.ts`  | `@mailwoman/bdc` (2a) + provider registry (2c)                 |
| Availability row shape (`CensusBlockAvailabilityRecord`)                                   | `sync/fcc/bdc/block-aggregator.ts`                                                      | bdc.db table schema (drop Parquet writer; ingest via DuckDB)   |
| BDC public-API client (rate-limited, `broadbandmap.fcc.gov/api/public`)                    | `sync/fcc/bdc/client.ts`                                                                | `bdc/sdk` — re-home env (`$private`→`core/env`) + lifecycle    |
| File listing + vintage/`as_of_date` resolution                                             | `sync/fcc/bdc/list-files.ts`, `filing-dates.ts`, `download-file.ts`, `path-builders.ts` | `bdc/sdk` fetch path                                           |
| Byte-level CSV parser                                                                      | `sync/fcc/bdc/parsing.ts`                                                               | `bdc/sdk` ingest                                               |
| Fabric-without-Fabric (location→block from free per-provider CSVs)                         | `sync/commands/bdc/infer-locations.ts`                                                  | `bdc/sdk` — **Redis dedup → sqlite staging** (§6)              |
| CORES scraper + Form-499 parser + entity classification                                    | `sync/fcc/CORESClient.ts`, `sync/fcc/universal-service.ts`                              | provider registry layer (2c)                                   |
| Organization / PointOfContact / OrganizationClassification models                          | Nexus `mailwoman/organization/*`, `mailwoman/contacts/PointOfContact.ts`                | provider registry entity shell (2c) — see §5.1                 |
| Block×availability×demographics rollup SQL                                                 | `sync/commands/bdc/generate-provider-geojson.ts`                                        | design reference for `aggregate()` / `market_size`             |

### Already ported — do not re-port

- **H3 48-bit short-cell packing**: `@mailwoman/spatial/h3` already exports `shortenH3Cell`,
  `expandH3Cell`, `shortCellToPoint`, and `cellToPointLiteral`, which landed in Phase 1. Nexus stores the
  short cell as a hex string, and mailwoman packs it into an **integer** for the clustered B-tree. Use
  the mailwoman form and never the hex string.
- **TIGER block model with population/housing/area**: `@mailwoman/tiger` already has
  `TIGERBlockTable` + `PLBlockTable` (§2.4). Reuse it. The only new work is the layer-interface
  wrapper. Block-intersection _queries_ may be new. Add them to `@mailwoman/tiger` or compose them
  from `@mailwoman/spatial`, and do not fork a second block model.

### Does not port, and why

- **Fabric data-source / migrations** (`sync/fcc/fabric/*`) are CostQuest-licensed (§2.2) and never port.
- **Redis** (dedup in `infer-locations.ts`, the `RedisManager`) is replaced by sqlite staging under
  house DB rules, so the ingest depends on no external service.
- **Parquet reader/writer** (`ParquetReader`/`ParquetWriter`) is replaced by the house pattern of DuckDB
  `read_parquet` into the SQLite output table (see the `build-postal-city-alias.ts` precedent).
- **`@isp.nexus/core` lifecycle, the `$private` env, and the yargs CLI** move to mailwoman's
  `core/env` (under the rule against raw `process.env`), the mailwoman async-init/lifecycle, and Pastel
  `cli-kit`. The `ServiceRepository.register` pattern in `client.ts` maps to the async-init
  package.
- **ECFS / ULS clients and CAF / RDOF / tribal ingest** do not exist in Nexus. They are new work and are
  deferred, and the subsidy registry was already deferred in Phase 1.

### 5.1 The contacts gap (from the integration notes)

Mailwoman has no contacts/organization _entity_ today. `OrganizationName`
(`record/organization.ts`) is a name-canonicalization value object without an id, an FRN, or linked
places, and it explicitly defers acronym/DBA/TF-IDF org _matching_ to "the matcher epic." The
Nexus `Organization` / `PointOfContact` / `OrganizationClassification` models supply the entity
shell, and `@mailwoman/record` supplies the name normalization. The salvage rule applies: **do not duplicate
`OrganizationName`**. The provider registry becomes a versioned-refresh layer of
organizations keyed by FRN, and the existing matcher joins it to places without a new subsystem. This
work is 2c.

## 6. Named costs

- **`enum` → const object.** Every salvaged FCC dictionary type is a TS `enum`
  (`BroadbandTechnologyCode`, `AddressConfidenceCode`, `LandUseCode`, `BSLFlag`). `erasableSyntaxOnly`
  forbids `enum` repo-wide, so each one ports as `const X = {…} as const` + `type X = (typeof
X)[keyof typeof X]`. The change is mechanical but touches every dictionary file.
- **Redis → sqlite staging** for the fabric-without-fabric dedup means rewriting the dedup pass instead of copying it. The staging DB is a temporary artifact that is built and then discarded.
- **bdc.db scale**: a nationwide fixed-broadband vintage is ~10^8 rows, and a continental shipped tier
  has a real R2 and build-time cost. A pilot pocket followed by scale-up is the likely answer (decide at 2a exit).
- **BSL block-granularity ceiling**: the Fabric point is licensed, so every per-address
  plausibility answer is a block-level inference. This limits correctness by design and is not a bug. The
  bundle must always flag a block-grain inference as one.
- **OSM telecom sparsity**: telecom-infra coverage in OSM is thin and uneven. The physical
  check fires positively much less frequently than the filing evidence, and the coverage table
  is what prevents its absence from being over-read.

## 7. Phasing

Phases are sized in agent-nights per house convention, without calendar dates. Each phase gets its own plan file after
this spec is reviewed.

### 2a — bdc.db + `filing_landscape` (~3–4 agent-nights)

Scope: the `@mailwoman/bdc` workspace skeleton; salvage of the BDC client, vintage/file listing, and
CSV parser (`enum`→const, env re-home); the bdc.db Kysely schema intersecting
`layerschemadatabase`; the fabric-without-fabric ingest (Redis→sqlite staging) for one pilot
state; the layer reader + `filing_landscape`; and the `mailwoman_bdc_filing_landscape` MCP tool.

Checks (pre-registered):

- Layer-interface conformance: `readLayerManifest`/`readLayerCoverage` pass, and h3 is packed as a res-9
  integer short cell (byte-compatible with the poi.db / address-id join).
- Coverage and meaning-of-zero test: an unsurveyed block returns `undefined` from
  `readLayerCoverage`, and `filing_landscape` reports it as unknown, never zero.
- `filing_landscape` returns the correct provider/tech/speed census for a known block against a
  hand-verified BDC fixture (fixtures→smoke→full ladder, per the poi.db runbook).
- Every answer carries the vintage (`source_vintage` = `as_of_date`), and the tool reports it.

### 2b — `plausibility_check` + infra builders (~2–3 agent-nights)

Scope: telecom-infra categories in `@mailwoman/poi-taxonomy` (infrastructure-extension
namespace); `poi build --source osm` recognizes the telecom tags (a build-local layer, with
no ODbL data shipped); the `plausibility.ts` scorer, which combines filing evidence and `nearest()` physical
evidence into the `{ claim, evidence_found, coverage_confidence }` bundle; and the
`mailwoman_plausibility_check` MCP tool.

Checks:

- **Positive-evidence-only invariant test**: a fixture with a claim in a block that has no
  filing and no plant within range returns "unknown / insufficient evidence." The test asserts that the scorer
  can never emit "implausible" from an absence (§4). This is the required check.
- Co-presence path: a claim with a matching filing and well-surveyed plant close by returns high
  `evidence_found` + high `coverage_confidence`.
- Layer-absent path: with the OSM infra layer absent, the bundle says "requires the
  locally-built OSM infra layer," and never gives a made-up distance.
- Every per-address answer carries the block-grain flag.

### 2c — provider registry + CRM via record/match (~3 agent-nights)

Scope: salvage of CORES/Form-499 and the `Organization`/`PointOfContact` entity shell; the provider
registry as a `versioned-refresh` layer (organizations keyed by FRN); provider↔place wiring through
the existing matcher (`HierarchyNode.placeID` as a blocking key, FRN as an `exactDiscriminator`,
brand/DBA as scored `nameSimilarity`, per the integration notes); and the private-CRM-layer path
and `reconcile.ts` buckets ("our building in a competitor-claimed-served block").

Checks:

- The provider registry conforms to the layer interface (versioned-refresh, FRN-keyed).
- `OrganizationName` is not duplicated. The existing matcher performs the join, and no new contacts subsystem
  exists (reviewer check against §5.1).
- A reconcile fixture produces the enrolled / present-not-in-base buckets over a synthetic
  CRM + bdc.db pair.
- The private-tier CRM layer loads from `$MAILWOMAN_DATA_ROOT` and never leaves the machine.

## 8. Open questions (for operator / counsel)

1. **CostQuest Fabric boundary**: confirm with counsel that carrying the BSL `location_id` as an
   opaque join key, without a coordinate or a derived table, stays clear of the Fabric license. §2.2 is
   written on that assumption, and the answer blocks 2a.
2. **bdc.db distribution**: ship it continental (~10^8 rows, R2 cost), or ship a pilot pocket and make
   the rest build-local? Decide at 2a exit. The answer affects the manifest tier and the build CLI.
3. **Which states first?** BDC is US-only (FCC). poi.db piloted CA for the demo probes. Should BDC
   also pilot CA (to align with the demo) or a target market state (for product demand)?
4. **BDC vintage cadence and refresh ownership**: confirm the twice-yearly `as_of_date` cadence, and decide who
   re-issues bdc.db for each vintage (the `versioned-refresh` curator question).
5. **HIFLD power.db**: is the grid layer we would want public-domain or access-restricted? The answer decides
   whether §2.6 ever leaves the deferred list.
6. **OSM telecom infra ODbL**: this needs the same counsel sign-off as the unpublished `osm/` workspace. The
   build-local infra builder ships, but confirm that the licensing position is identical.
7. **Market-size denominator**: confirm that TIGER `housing_unit_count` is an acceptable public proxy
   for the addressable-unit count, since the Fabric BSL count per block is licensed and unusable.
8. **Provider registry (CORES/Form-499)**: decide the refresh cadence and curator ownership for 2c.
