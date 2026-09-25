# Spatial layers + POI queries — design

2026-07-18. The operator and Claude brainstormed this design in one session. Research receipts are in
`scratchpad/exotic-poi-a-vs-b-research.md` (four parallel research passes: geocoder prior art,
NLU literature, repo cost audit, Overture taxonomy/licensing) and in the Nexus salvage survey
(session transcript). This spec is the engineering companion to `docs/articles/understanding/exotic-poi/`.

## 1. Framing

Mailwoman today answers one question: "where is this address?" The operator wants to answer the
related questions around it: physical-plausibility checks on broadband filings,
infrastructure proximity ("how far is this fiber hut from a datacenter?"), build-out feasibility, and
market sizing. No single model answers these composite questions. The consumer of these
queries is an **agent** (an LLM with tools), not a search box. The agent supplies intent
extraction, planning, and narrative. Mailwoman supplies what the agent lacks: **deterministic,
local, fast, provenance-tracked spatial ground truth.**

This settles the original design question of a trained decoder that emits OverpassQL vs. a pipeline
extension. The research favored the pipeline extension on all four fronts:

1. **Industry practice**: every production geocoder (Nominatim special phrases, Photon, Pelias,
   Mapbox, HERE, Google) treats category/brand intent as classification into a closed taxonomy.
   Their learned parts rank and disambiguate, and none of them generate queries.
2. **The generative path has been tried**: Text-to-OverpassQL (TACL 2024) reached
   36.7% execution accuracy with 582M params, and GPT-4 with retrieval reached 40.4%. No production deployment of a small
   generative geo-query model exists.
3. **NLU literature**: flat queries (a subject with an optional anchor, which is exactly the shape of POI queries) suit
   a tagger. Generation pays off only on nested intents. Autoregressive decoding costs 5–20× the latency
   of our single thread-blocking `session.run`.
4. **This repo**: option A assembles existing parts (a `QueryKind`, a scorer, the first consumer of `variant-aliases`,
   and a sealed poi.db). Option B is a second ML product line that still needs poi.db
   to answer anything.

**Pre-registered escalation**, so that option B is not reopened ad hoc: if evals show that lexicon recall
is the binding constraint, the fix is an intent+slot head on the existing encoder
(JointBERT/Alexa pattern, ~10 examples/class), not a decoder.

Overpass itself is never a serving backend. It interprets QL over a planet export, is rate-limited, and takes
seconds to minutes. An OverpassQL _emitter_ may exist as a pure export format over the intent
record. We print the query but never run it.

## 2. Governing architecture — three layers

### 2.1 Spatial layer registry (data)

Every dataset, whether shipped, user-built, or private, has the same artifact shape: a **sealed,
readonly, provenance-tracked SQLite database** (a "layer") keyed on a shared spatial spine.
This extends the existing gazetteer practices (sealed 0444 artifacts, Kysely schema modules,
build-then-swap) from reference data to analysis layers.

**The spine.** Every layer row is addressable by at least one of these keys:

- `h3`: an H3 cell, stored as a 48-bit short cell (port `shortenH3Cell`/`expandH3Cell` from Nexus
  `spatial/h3`). The layer manifest declares the resolution per table.
- `wof_id`: the WOF ancestry anchor, in the resolver's existing id space. Parallel id spaces stay
  nullable metadata, per the GERS rule.
- `address_id`: the `@mailwoman/address-id` key, for layers whose rows are address-grained.

**The manifest.** Each layer embeds a single-row `layer_manifest` table:

| field                                                | meaning                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `name`, `version`, `schema_version`                  | identity                                                                 |
| `tier`                                               | `shipped` \| `build-local` \| `private`                                  |
| `license`, `attribution`                             | e.g. CDLA-Permissive-2.0; ODbL for build-local layers                    |
| `source`, `source_vintage`, `build_cmd`, `build_sha` | provenance (pin baselines: SHA + command)                                |
| `freshness_policy`                                   | `sealed` (rebuild-only) \| `versioned-refresh` (e.g. officials registry) |
| `spine_keys`                                         | which spine columns this layer carries, and H3 resolution                |

**Coverage metadata and the meaning of zero.** Layers derived from incomplete surveys (OSM
above all) must carry a `layer_coverage` table that gives a completeness signal per H3 cell at a coarse resolution. Consumers can then
distinguish "mapped and absent" from "unmapped." A missing row is never
evidence by itself. Scorers built on layers emit `{claim, evidence_found, coverage_confidence}`
instead of a bare score. The interface requires this field from the first release, because adding
coverage data to sealed artifacts later would mean rebuilding all of them.

**Tiers.**

- `shipped`: permissive sources only (Overture Places CDLA-P, Census/TIGER public domain,
  Wikidata CC0, Foursquare labels Apache-2.0). We build these layers and publish them to R2/npm like the gazetteer.
- `build-local`: ODbL and other share-alike sources, such as OSM POIs and the Overture _base_ theme.
  The base theme is explicitly ODbL, because Overture's license does not replace OSM's. We ship the **builder CLI**, the user
  builds the layer on their own disk, and we distribute nothing under ODbL. The unpublished
  `osm/` workspace follows the same policy.
- `private`: the user's own data (CRM, survey notes, parcel relationships). It conforms to the
  same schema interface, loads from `$MAILWOMAN_DATA_ROOT`, and never leaves the user's machine. This is
  how "internal geo" (who owns the building, whether we have worked with this builder) joins the same
  query surface as public layers.

### 2.2 Spatial primitives (compute)

`@mailwoman/spatial` grows a small closed verb set over the layer interface:
`nearest(layer, from, k)`, `within(layer, center, radius)`, `distance(a, b)`,
`aggregate(layer, h3res)`. A later `along(street-network, a, b)` over TIGER geometry answers
route-length questions ($/mile builds). The primitives are deterministic and unit-tested, and they use no ML.

### 2.3 Agent surface (`@mailwoman/mcp`)

An MCP server exposes the toolset: `parse`, `geocode`, `poi_search(category|brand|name, near,
radius, limit)`, `layer_list`, `layer_query`, `spatial_nearest`, `spatial_within`, and
`spatial_distance`. The server is thin: it holds schemas and dispatches to existing library calls, with no logic of its own.
The POI **intent record** (§3.2) also serves as the `poi_search` tool schema. Human natural-language surfaces
(CLI, demo, photon drop-in) are thin fronts on the same calls, and agents skip natural language entirely.

**Scope limit.** Mailwoman ships the spine, layers, primitives, and tool surface. Verticals
(BDC plausibility, build-out feasibility) stay agent workflows built from skills, docs, and examples. They
become new packages only after one shows product demand. As with BAN, we test the implementation on one
vertical before expanding.

## 3. Phase 1 — the POI arc (implementable now)

This phase extends the Fable exotic-POI spec (scratchpad/fable-exotic-poi-design.md). That spec's Phases 0–2
(coordinate kind, venue gazetteer extract, venue-fragment retrain) proceed as written. This spec
adds the amenity/brand/intent half and moves venue data into layer #1.

### 3.1 Pipeline: `poi_query` kind

- New `QueryKind` union member `poi_query` (`core/pipeline/types.ts`).
- A new scorer in `kind-classifier` (modeled on `scoreVenueLandmark`) fires on a lexicon hit for a
  category/brand phrase. The already-reserved `locale` param blocks locale-specific
  aliases. This deliberately relaxes the classifier's docstring invariant against place-name dictionaries.
  The lexicon lives in `variant-aliases` data and is injected instead of hardcoded.
- Anchor split: on a `poi_query` hit, the subject phrase is stripped, and the remainder
  (`near Springfield IL`, `, Portland OR`) runs through the normal parse→resolve path.
  The split has two stages, and stage 2 is the existing model.
- New pipeline branch: POI results are not `AddressTree`s. `runPipeline` gains an optional
  `poiResolver` stage and a distinct result shape, which gives `PipelineResult.kind` its first
  consumer. The API gains a response variant, and drop-ins map it natively (photon: FeatureCollection).
- Relative-position and leader queries (`behind the church…`) return an abstain result
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

Two compilers read `POIIntent`: (a) SQL against poi.db, which is the only executor, and (b) an OverpassQL
emitter, which is export-only and prints text. The record is also the `poi_search` MCP schema.

### 3.3 The lexicon (`variant-aliases` grows up)

The taxonomy is general-purpose and covers biking trails, restaurants, and hospitals as well as
ISP-adjacent categories. It therefore splits from `variant-aliases`:

- **New data package `@mailwoman/poi-taxonomy`**: the Overture category snapshot (ids +
  hierarchy + basic-label tier) plus the synonym table (phrase → category id). The synonym table starts
  from Foursquare OS Places labels (Apache-2.0) and Wikidata aliases (CC0) and is then curated.
  The package is versioned per Overture release, so its refresh cadence and size class differ from
  variant-aliases. It pins the new Overture `taxonomy` property (~2,100 categories, 13 top-level,
  ~280 basic labels). The old `categories` property is removed in the Sept 2026 Overture release, and
  Overture does not yet publish the new taxonomy's canonical list as a committed machine-readable file, so snapshot it
  into the package build for each release. Nominatim special phrases and the OSM wiki are CC BY-SA.
  Consult them as reference, and never ship a table derived from them.
- **`variant-aliases` stays** as the small curated locale-slang table (`Macca's`, `PFK`, `servo`).
  Its entries now resolve to poi-taxonomy category ids or brand names, which gives the package its first consumer.
- Brand aliases are keyed by Wikidata QID (CC0) and joined to Overture `brand.wikidata` (~3,000 chains).

### 3.4 poi.db — layer #1

- Source: Overture Places (CDLA-P) filtered to confidence ≥ 0.85, the point where third-party audits found reliability levels off.
  Each row carries `taxonomy.primary`/`hierarchy`/`alternates`, `brand.*`, names, a centroid, and the GERS id as nullable
  metadata. The build assigns WOF-keyed ancestry by PIP against the existing gazetteer.
- The schema follows house rules: a Kysely schema module + `createXTable`, a staging bulk-load through raw
  positional INSERTs, a `WITHOUT ROWID` candidate-style probe table (clone
  `resolver-wof-sqlite/candidate-*`), FTS5 name search (raw DDL, per rule), sealing at 0444, and the
  layer manifest + coverage table from §2.1.
- Build: `mailwoman gazetteer build poi`, an Overture places ingest modeled on the existing divisions ingest.
  The operator set the scope to **the countries of all currently supported locales (US, CA, MX, FR)**.
  California rows cover the demo-preset acceptance probes (`Pier 39` /
  `Golden Gate Park`). Including POI data in the demo (Tier A pocket) needs a separate budget review.
- The venue resolve half (the placetypeMap `venue` entry and the resolve.ts venue pass) proceeds per the
  Fable spec Phase 1. poi.db serves both the venue lookup and category/brand search.

### 3.5 Infrastructure classes (build-local)

`fire_hydrant`, `post_box`, `drinking_water`, `data_center`, and similar classes have no permissive source.
They exist only in OSM and in Overture's _base_ theme, and both are ODbL. Ship `poi build --source osm`,
which reuses `osm/sdk` ingestion to produce a build-local layer with the same schema.
The category lexicon still recognizes these subjects when the layer is absent. The answer is
then "requires the locally-built OSM layer," not a mangled parse.

### 3.6 Checks (pre-registered)

- The golden 2pp check passes with the `poi_query` scorer live, and non-POI queries produce byte-identical parses.
- A curated POI query board (the class-1/9 probe table + amenity/brand/infra fixtures) gets
  written floors at the Phase-1 baseline. It is graded on the assembled answer (id + coordinate), not
  label F1.
- Full-address venue queries (class 2) do not regress.
- The new stage and scorer get runtime-flag register rows (invariant 5). With the flag off, output is byte-identical.
- Demo presets stay green. Once the venue extract lands, the acceptance probe is Pier 39 resolving to the pier
  instead of the SF centroid.

## 4. Phase 2 — BDC plausibility (proving-ground vertical; separate spec)

This section describes Phase 2 so that Phase 1 decisions can serve it. It gets its own spec once Phase 1's interface exists.

Phase 2 grades broadband availability filings by physical plausibility. It asks whether claimed
fiber service has the physical plant it needs: a datacenter within reasonable distance, fiber
huts, and power. The score is `{claim, supporting evidence found, coverage_confidence}`. The
highest-confidence positive is co-presence. Where OSM coverage is sparse, the result degrades toward "insufficient
survey data," and that result is itself reported.

**Nexus salvage map** (`/home/lab/Projects/isp-nexus/universe`, AGPL). The operator is the sole author
and has approved relicensing by copy. The salvage rule is to copy code in without provenance headers
and to **never duplicate functionality mailwoman already has**. Nexus TIGER work merges
into the existing `tiger/` workspace, H3 utilities go into `@mailwoman/spatial`, and fetch/ingest code goes into
`sdk/`-style submodules. All storage moves to Kysely/node:sqlite per house rules:

| Salvage                                                                                                                                                                           | From                                   | Into                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| FCC/BDC typed data dictionary (`NTIARecord` w/ `h3_9`, BSL ids, tech codes 10–90, `BroadbandProvider`, FRN/Form-499)                                                              | `fcc/`                                 | schema source for bdc.db (lift ~whole)     |
| BDC public-data client (rate-limited, `broadbandmap.fcc.gov/api/public`, vendored OpenAPI incl. funding map) + zip→CSV pipeline + byte-level CSV parser + filename→vintage parser | `sync/fcc/bdc/`                        | `bdc/sdk` fetch path (re-home storage)     |
| Fabric-without-Fabric: infer location→block from free per-provider CSVs                                                                                                           | `sync/commands/bdc/infer-locations.ts` | rework Redis dedup → sqlite staging        |
| H3 48-bit short-cell packing                                                                                                                                                      | `spatial/h3`                           | `@mailwoman/spatial` (spine)               |
| TIGER block model w/ population/housing/area + intersection queries                                                                                                               | `tiger/`                               | demographic layer (market sizing)          |
| CORES scraper + Form 499 parser + entity classification                                                                                                                           | `sync/fcc/`                            | provider registry (freshness-policy layer) |
| Block/tract/county availability×demographics rollup SQL                                                                                                                           | `generate-provider-geojson.ts`         | design reference for `aggregate()`         |

Known gaps that need new work: there are no ECFS/ULS clients and no CAF/RDOF/tribal ingest, and H3-keyed storage is new
(Nexus joined on GEOID). CostQuest fabric IDs are treated as opaque join keys. We work at the
granularity the public filings support and grade claims against physical evidence instead of
the fabric's own map.

Implied layers: `bdc.db` (shipped; US-gov public filings), `infra.db` (build-local, ODbL),
`power.db` (HIFLD candidate, license check pending), TIGER demographics (shipped), and the
provider registry (shipped, versioned-refresh). A second vertical, build-out feasibility
(situs 124.9M points × ACS income × along-network distance × BDC competitors), reuses all of these layers.

## 5. Deferred, explicitly

- A subsidy-program registry. It churns and needs versioned refreshes and a curator.
- Zoning. It is fragmented per municipality and could at best be a per-project build-local layer.
- An officials/constituency directory beyond jurisdiction boundaries. TIGER districts can
  ship now, but the _people_ churn. Soft-power analysis stays in the conversation and out of the
  artifact, and mailwoman's layers stay limited to public-record structure.
- Free-form phrasing recall (→ pre-registered escalation, §1).
- The OverpassQL emitter can ship in any phase because it is a pure formatter. It has the lowest priority.

## 6. Sequencing

1. **Layer interface** (manifest + coverage tables + tier semantics) comes first, so poi.db
   conforms from its first build. It is a small PR with a schema module and a docs page.
2. **Phase 1 POI arc**: kind + intent record + lexicon wiring + poi.db pilot (CA) + pipeline
   branch + API/CLI surfaces. The repo-cost audit estimates 3 wiring PRs and 1 data PR.
3. **`@mailwoman/mcp`** is thin and can land in parallel with (2) once the intent record is typed.
4. **Fable spec Phases 0–2** (coordinate kind, venue resolve, venue-fragment retrain) stay
   unchanged and are interleaved as the operator schedules them.
5. **Phase 2 BDC spec** comes after (1)–(3) produce results on poi.db.

## 7. Decisions (resolved 2026-07-18, operator)

- The MCP server ships in v1 alongside Phase 1.
- poi.db scope: the countries of all currently supported locales (US, CA, MX, FR).
- Nexus salvage: copy files in under the same-author relicense, without provenance headers, and never duplicate
  existing mailwoman functionality. Merge into an existing workspace wherever one exists.
- Lexicon home: split. General-purpose categories and synonyms go in the new
  `@mailwoman/poi-taxonomy` data package, and locale slang stays in `variant-aliases` (§3.3).
  The taxonomy serves every category use case (trails, restaurants, and ISP infrastructure alike)
  and refreshes on Overture's release cadence instead of a curation cadence.

- poi.db H3 keying (resolved 2026-07-18, delegated to Claude): rows key on the **res-9 48-bit
  short cell** as the clustered probe prefix. This matches `ADDRESS_H3_RESOLUTION = 9` in
  `@mailwoman/address-id`, so the POI↔address join is a direct key equality. Exact centroids
  stay on the row, because finer granularity cannot be derived from a coarser key. The choice follows the serving
  profile. The browser/React-Native/web-worker path makes byte-range probes against a remote sealed
  DB, and a res-9-clustered `WITHOUT ROWID` B-tree turns a neighborhood query into one contiguous
  key range with few range requests and no joins. The candidate
  gazetteer uses the same access pattern. `layer_coverage` cells sit at res 6 because they describe coverage and are not used for lookups.

Still open: when the demo pocket gets a slim POI extract. The budget review at Phase-1 exit decides this.
