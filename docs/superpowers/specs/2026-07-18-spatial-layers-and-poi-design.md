# Spatial layers + POI queries — design

2026-07-18. Operator + Claude, brainstormed over one session; research receipts in
`scratchpad/exotic-poi-a-vs-b-research.md` (four parallel research passes: geocoder prior art,
NLU literature, repo cost audit, Overture taxonomy/licensing) and the Nexus salvage survey
(session transcript). Companion engineering half of `docs/articles/understanding/exotic-poi/`.

## 1. Framing

Mailwoman today answers one question: "where is this address?" The operator's target is the
question class _around_ that one — physical-plausibility checks on broadband filings,
infrastructure proximity ("how far is this fiber hut from a datacenter?"), build-out feasibility,
market sizing. These are composite questions no single model answers. The consumer of these
queries is an **agent** (an LLM with tools), not a search box. The agent supplies intent
extraction, planning, and narrative; mailwoman supplies what the agent lacks: **deterministic,
local, fast, provenance-tracked spatial ground truth.**

This resolves the original design question (trained decoder emitting OverpassQL vs. pipeline
extension) decisively. Research verdict, one-sided on four fronts:

1. **Industry practice**: every production geocoder (Nominatim special phrases, Photon, Pelias,
   Mapbox, HERE, Google) treats category/brand intent as classification into a closed taxonomy.
   The learned parts are rankers/disambiguators, never generators.
2. **The generative path has been tried**: Text-to-OverpassQL (TACL 2024) — 582M params for
   36.7% execution accuracy; GPT-4 + retrieval 40.4%. No production deployment of a small
   generative geo-query model exists.
3. **NLU literature**: flat queries (subject × optional anchor — exactly POI queries) are tagger
   territory; generation pays only on nested intents. Autoregressive decode = 5–20× the latency
   of our single thread-blocking `session.run`.
4. **This repo**: option A is assembly (a `QueryKind`, a scorer, `variant-aliases`' first
   consumer, a sealed poi.db); option B is a second ML product line that still needs poi.db
   to answer anything.

**Pre-registered escalation** (so B is never re-litigated ad hoc): if evals show lexicon recall
is the binding constraint, the fix is an intent+slot head on the EXISTING encoder
(JointBERT/Alexa pattern, ~10 examples/class) — not a decoder.

Overpass itself: never a serving backend (interpreted QL over a planet export, rate-limited,
seconds-to-minutes). An OverpassQL _emitter_ may exist as a pure export format over the intent
record — we print the query; we never run it.

## 2. Governing architecture — three layers

### 2.1 Spatial layer registry (data)

Every dataset — shipped, user-built, or private — is the same artifact shape: a **sealed,
readonly, provenance-tracked SQLite database** ("layer") keyed on a shared spatial spine.
This extends the existing gazetteer discipline (sealed 0444 artifacts, Kysely schema modules,
build-then-swap) from reference data to analysis layers.

**The spine.** Every layer row is addressable by at least one of:

- `h3` — H3 cell, stored as 48-bit short cell (port `shortenH3Cell`/`expandH3Cell` from Nexus
  `spatial/h3`). Resolution declared per-table in the layer manifest.
- `wof_id` — WOF ancestry anchor (the resolver's existing id space; parallel id spaces stay
  nullable metadata, per the GERS rule).
- `address_id` — the `@mailwoman/address-id` key, where rows are address-grained.

**The manifest.** Each layer embeds a `layer_manifest` table (single row):

| field                                                | meaning                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `name`, `version`, `schema_version`                  | identity                                                                 |
| `tier`                                               | `shipped` \| `build-local` \| `private`                                  |
| `license`, `attribution`                             | e.g. CDLA-Permissive-2.0; ODbL for build-local layers                    |
| `source`, `source_vintage`, `build_cmd`, `build_sha` | provenance (pin baselines: SHA + command)                                |
| `freshness_policy`                                   | `sealed` (rebuild-only) \| `versioned-refresh` (e.g. officials registry) |
| `spine_keys`                                         | which spine columns this layer carries, and H3 resolution                |

**Coverage metadata — the meaning-of-zero rule.** Layers derived from incomplete surveys (OSM
above all) MUST carry a `layer_coverage` table: per-H3-cell (coarse res) completeness signal, so
consumers can distinguish "mapped and absent" from "unmapped." Absence of a row is never
evidence by itself. Scorers built on layers emit `{claim, evidence_found, coverage_confidence}`,
never a bare score. This field is contract-mandatory from day one because retrofitting
epistemics onto sealed artifacts means rebuilding all of them.

**Tiers.**

- `shipped` — permissive sources only (Overture Places CDLA-P, Census/TIGER public domain,
  Wikidata CC0, Foursquare labels Apache-2.0). Built by us, published R2/npm like the gazetteer.
- `build-local` — ODbL and other share-alike sources (OSM POIs, Overture _base_ theme — which
  is explicitly ODbL; Overture does not launder OSM). We ship the **builder CLI**, the user
  builds on their own disk, nothing ODbL is distributed by us. Same posture as the unpublished
  `osm/` workspace.
- `private` — the user's own data (CRM, survey notes, parcel relationships), conforming to the
  same schema contract, loaded from `$MAILWOMAN_DATA_ROOT`, never leaves their machine. This is
  how "internal geo" (who owns the building, have we worked with this builder) joins the same
  query surface as public layers.

### 2.2 Spatial primitives (compute)

`@mailwoman/spatial` grows a small closed verb set over the layer contract:
`nearest(layer, from, k)`, `within(layer, center, radius)`, `distance(a, b)`,
`aggregate(layer, h3res)`; later `along(street-network, a, b)` (TIGER geometry) for
route-length questions ($/mile builds). Deterministic, unit-tested, no ML.

### 2.3 Agent surface (`@mailwoman/mcp`)

An MCP server exposing the toolset: `parse`, `geocode`, `poi_search(category|brand|name, near,
radius, limit)`, `layer_list`, `layer_query`, `spatial_nearest`, `spatial_within`,
`spatial_distance`. Thin: schema + dispatch over existing library calls — no logic of its own.
The POI **intent record** (§3.2) doubles as the `poi_search` tool schema. Human NL surfaces
(CLI, demo, photon drop-in) are thin fronts on the same calls; agents skip NL entirely.

**Scope guard.** Mailwoman ships the spine, layers, primitives, and tool surface. Verticals
(BDC plausibility, build-out feasibility) are agent workflows — skills/docs/examples — not new
packages, until one proves product pull. (The BAN discipline: prove the mechanism on one
vertical before expanding.)

## 3. Phase 1 — the POI arc (implementable now)

Extends the Fable exotic-POI spec (scratchpad/fable-exotic-poi-design.md); its Phases 0–2
(coordinate kind, venue gazetteer shard, venue-fragment retrain) proceed as written. This spec
adds the amenity/brand/intent half and re-homes venue data as layer #1.

### 3.1 Pipeline: `poi_query` kind

- New `QueryKind` union member `poi_query` (`core/pipeline/types.ts`).
- New scorer in `kind-classifier` (template: `scoreVenueLandmark`): lexicon hit on a
  category/brand phrase, with the already-reserved `locale` param gating locale-specific
  aliases. The classifier's "no place-name dictionaries" docstring invariant is relaxed
  deliberately: the lexicon lives in `variant-aliases` data and is injected, not hardcoded.
- Anchor split: on a `poi_query` hit, the subject phrase is stripped and the remainder
  (`near Springfield IL`, `, Portland OR`) runs through the normal parse→resolve path.
  Two-stage, where stage 2 is the existing model.
- New pipeline branch: POI results are not `AddressTree`s. `runPipeline` gains an optional
  `poiResolver` stage and a distinct result shape (`PipelineResult.kind` finally gets a
  consumer). API gains a response variant; drop-ins map it natively (photon: FeatureCollection).
- Relative-position/leader queries (`behind the church…`): abstain result
  (`kind=landmark, confidence, no coordinate`), per the Fable spec.

### 3.2 Intent record

```ts
interface POIIntent {
	subject:
		| { kind: "category"; id: OvertureCategoryID; matched: string }
		| { kind: "brand"; wikidata?: QID; name: string; matched: string }
		| { kind: "name"; text: string }
	anchor?: { resolved?: ResolvedPlace; biasPoint?: LngLat; radiusM?: number }
	limit?: number
}
```

Compilers over `POIIntent`: (a) SQL against poi.db (the only executor); (b) OverpassQL
emitter (export-only, prints text). The record is also the `poi_search` MCP schema.

### 3.3 The lexicon (`variant-aliases` grows up)

The taxonomy is general-purpose — biking trails, restaurants, hospitals — not ISP-specific;
ISP-adjacent categories are one slice of it. It therefore splits from `variant-aliases`:

- **New data package `@mailwoman/poi-taxonomy`**: the Overture category snapshot (ids +
  hierarchy + basic-label tier) plus the synonym table (phrase → category id), bootstrapped
  from Foursquare OS Places labels (Apache-2.0) + Wikidata aliases (CC0), then curated.
  Snapshot-versioned per Overture release — a different freshness cadence and size class than
  variant-aliases. Pins the NEW Overture `taxonomy` property (~2,100 categories, 13 top-level,
  ~280 basic labels); the old `categories` property dies in the Sept 2026 Overture release, and
  the new taxonomy's canonical list is not yet a committed machine-readable file — snapshot it
  per release into the package build. Nominatim special phrases / OSM wiki are CC BY-SA —
  consult as reference, never ship a derived table.
- **`variant-aliases` stays** the small curated locale-slang table (`Macca's`, `PFK`, `servo`),
  now resolving to poi-taxonomy category ids / brand names — it finally gets a consumer.
- Brand aliases: Wikidata QID-keyed (CC0), joined to Overture `brand.wikidata` (~3,000 chains).

### 3.4 poi.db — layer #1

- Source: Overture Places (CDLA-P), confidence ≥ 0.85 (the third-party-audit reliability knee),
  `taxonomy.primary`/`hierarchy`/`alternates`, `brand.*`, names, centroid, GERS id as nullable
  metadata. WOF-keyed ancestry via PIP against the existing gazetteer at build time.
- Schema per house discipline: Kysely schema module + `createXTable`, staging bulk-load via raw
  positional INSERTs, `WITHOUT ROWID` candidate-style probe table (clone
  `resolver-wof-sqlite/candidate-*`), FTS5 name search (raw DDL, per rule), sealed 0444,
  layer manifest + coverage table per §2.1.
- Build: `mailwoman gazetteer build poi` (Overture places ingest; the divisions ingest is
  precedent). Scope: **all currently supported locales' countries (US, CA, MX, FR)** —
  operator decision. California rows cover the demo-preset acceptance probes (Pier 39 /
  Golden Gate Park). Demo (Tier A pocket) inclusion is a separate budget review.
- Venue resolve half (placetypeMap `venue` entry, resolve.ts venue pass) proceeds per the
  Fable spec Phase 1; poi.db serves both the venue lookup and category/brand search.

### 3.5 Infrastructure classes (build-local)

`fire_hydrant`, `post_box`, `drinking_water`, `data_center` etc. have NO permissive source:
they live in OSM and in Overture's _base_ theme, both ODbL. Ship `poi build --source osm`
(reuse `osm/sdk` ingestion) producing a build-local layer conforming to the same schema.
The category lexicon still recognizes these subjects when the layer is absent — the answer is
then "requires the locally-built OSM layer," not a mangled parse.

### 3.6 Gates (pre-registered)

- Golden 2pp guard with the `poi_query` scorer live; byte-identical parses for non-POI queries.
- Curated POI query board (the class-1/9 probe table + amenity/brand/infra fixtures) with
  written floors set at Phase-1 baseline; graded on assembled answer (id + coordinate), not
  label F1.
- Full-address venue (class 2) non-regression.
- Runtime-flag register rows for the new stage + scorer (invariant 5); flag-off = byte-identical.
- Demo presets stay green; Pier 39 resolving to the pier (not SF centroid) is the acceptance
  probe once the venue shard lands.

## 4. Phase 2 — BDC plausibility (proving-ground vertical; separate spec)

Named here so Phase 1 decisions serve it; specced separately once Phase 1's contract is real.

The question: grade broadband availability filings by physical plausibility — does claimed
fiber service have the co-present physical plant (datacenter within reasonable distance, fiber
huts, power)? Score = `{claim, supporting evidence found, coverage_confidence}`; the
highest-confidence positive is co-presence; sparse OSM coverage degrades toward "insufficient
survey data," which is itself output.

**Nexus salvage map** (`/home/lab/Projects/isp-nexus/universe`, AGPL, operator is sole author
and has approved relicensing by copy). Salvage rule: copy code in, no provenance headers
required, and **never duplicate functionality mailwoman already has** — Nexus TIGER work merges
into the existing `tiger/` workspace, H3 utilities into `@mailwoman/spatial`, fetch/ingest into
`sdk/`-style submodules; all storage re-homed to Kysely/node:sqlite per house rules:

| Salvage                                                                                                                                                                           | From                                   | Into                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| FCC/BDC typed data dictionary (`NTIARecord` w/ `h3_9`, BSL ids, tech codes 10–90, `BroadbandProvider`, FRN/Form-499)                                                              | `fcc/`                                 | schema source for bdc.db (lift ~whole)     |
| BDC public-data client (rate-limited, `broadbandmap.fcc.gov/api/public`, vendored OpenAPI incl. funding map) + zip→CSV pipeline + byte-level CSV parser + filename→vintage parser | `sync/fcc/bdc/`                        | `bdc/sdk` fetch path (re-home storage)     |
| Fabric-without-Fabric: infer location→block from free per-provider CSVs                                                                                                           | `sync/commands/bdc/infer-locations.ts` | rework Redis dedup → sqlite staging        |
| H3 48-bit short-cell packing                                                                                                                                                      | `spatial/h3`                           | `@mailwoman/spatial` (spine)               |
| TIGER block model w/ population/housing/area + intersection queries                                                                                                               | `tiger/`                               | demographic layer (market sizing)          |
| CORES scraper + Form 499 parser + entity classification                                                                                                                           | `sync/fcc/`                            | provider registry (freshness-policy layer) |
| Block/tract/county availability×demographics rollup SQL                                                                                                                           | `generate-provider-geojson.ts`         | design reference for `aggregate()`         |

Known gaps (new work): no ECFS/ULS clients, no CAF/RDOF/tribal ingest, H3-keyed storage is new
(Nexus joined on GEOID). CostQuest fabric IDs are treated as opaque join keys; we work at the
granularity the public filings actually support and grade claims against physics, not against
the fabric's own map.

Layers implied: `bdc.db` (shipped; US-gov public filings), `infra.db` (build-local, ODbL),
`power.db` (HIFLD candidate — license check pending), TIGER demographics (shipped),
provider registry (shipped, versioned-refresh). Second vertical (build-out feasibility:
situs 124.9M points × ACS income × along-network distance × BDC competitors) reuses all of it.

## 5. Deferred, explicitly

- Subsidy-program registry (churny; needs versioned-refresh discipline and a curator).
- Zoning (per-municipality fragmentation; per-project build-local at best).
- Officials/constituency directory beyond jurisdiction boundaries (TIGER districts are
  shippable now; _people_ churn). Soft-power analysis stays in the conversation, not the
  artifact — mailwoman's layers stay public-record structure.
- Free-form phrasing recall (→ pre-registered escalation, §1).
- OverpassQL emitter can ship in any phase — it's a pure formatter; lowest priority.

## 6. Sequencing

1. **Layer contract** (manifest + coverage tables + tier semantics) — first, so poi.db is born
   conforming. Small PR: schema module + docs page.
2. **Phase 1 POI arc** — kind + intent record + lexicon wiring + poi.db pilot (CA) + pipeline
   branch + API/CLI surfaces. 3 wiring PRs + 1 data PR, per the repo-cost audit.
3. **`@mailwoman/mcp`** — thin; can land in parallel with (2) once the intent record is typed.
4. **Fable spec Phases 0–2** (coordinate kind, venue resolve, venue-fragment retrain) —
   unchanged, interleaved as operator schedules them.
5. **Phase 2 BDC spec** — after (1)–(3) prove the contract on poi.db.

## 7. Decisions (resolved 2026-07-18, operator)

- MCP server ships in v1 alongside Phase 1.
- poi.db scope: all currently supported locales' countries (US, CA, MX, FR).
- Nexus salvage: copy files in (same-author relicense), no provenance headers, never duplicate
  existing mailwoman functionality — merge into existing workspaces where one exists.
- Lexicon home: split — general-purpose categories + synonyms in the new
  `@mailwoman/poi-taxonomy` data package; locale slang stays in `variant-aliases` (§3.3).
  Rationale: the taxonomy serves every category use case (trails, restaurants, ISP infra alike)
  and refreshes on Overture's cadence, not curation cadence.

- poi.db H3 keying (resolved 2026-07-18, delegated to Claude): rows key on the **res-9 48-bit
  short cell** as the clustered probe prefix — matching `ADDRESS_H3_RESOLUTION = 9` in
  `@mailwoman/address-id` so the POI↔address join is a direct key equality. Exact centroids
  stay on the row (finer granularity derivable; coarser is not). Rationale is the serving
  profile: the browser/React-Native/web-worker path is byte-range probes over a remote sealed
  DB, and a res-9-clustered `WITHOUT ROWID` B-tree makes a neighborhood query one contiguous
  key range (few range requests, no joins) — the same access pattern as the candidate
  gazetteer. `layer_coverage` cells sit at res 6 (epistemics, not lookups).

Remaining open: when the demo pocket gets a slim POI shard (budget review at Phase-1 exit).
