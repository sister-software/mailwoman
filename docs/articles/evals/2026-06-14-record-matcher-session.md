# Record-matcher session handoff — 2026-06-14 (Heather's shift)

_For the next Claude. You have no memory of this session beyond the auto-loaded
`project-record-matcher.md` memory file; this is the full narrative + file map so you
can pick up cleanly. Everything below is on branch `feat/record-matcher-foundation`,
draft PR #607, Project #5._

## TL;DR

We revived the contact/organization **record-matcher** mailwoman was originally built
to serve (clinic federal/state funding eligibility: normalize → geocode → match →
QGIS → leads; it imploded years ago on the record-matching step). In one shift we
built the **entire geocode-first entity-resolution system end to end**, label-free,
across **four new workspaces** and **14 commits**, with **121 passing tests** in the
new packages (+170 corpus tests still green through a migration). Nothing is merged;
it's all a draft PR awaiting review/CI/split. The only thing left to _run it on real
data_ is a CLI command that injects the heavy geocoder (operator-verifiable; the
weights/shards aren't in the worktree).

## What got built — the cascade

```
CSV / SQLite -ingest-> normalize (name, org, address) -[GeocodeAddress seam]-> SourceRecord
   -> @mailwoman/match  BLOCK (geo | canonical | phone | email)
                        SCORE (Jaro-Winkler, distance buckets, Fellegi-Sunter;
                               m/u learned label-free by EM; rare values up-weighted by TF)
                        CLUSTER (connected components)
   -> @mailwoman/registry  ResolvedEntity[] -> toGeoJSON -> QGIS
```

The thesis, proven in a capstone test: two records reading `123 main st` and
`123 main street apt 2` — **different strings** — resolve to one entity because they
share a **location** and a name. Blocking is geographic, not textual. That's why this
version works where the string-first v0 imploded.

## The four new workspaces (and what's in each file)

- **`@mailwoman/formatter`** (#599) — the inverse of the parser.
  - `format.ts`: `formatAddress(components, country, opts)` (ComponentTag to idiomatic
    string, wraps `@fragaria/address-formatter`), `formatFromClassificationMap` (bridges
    the legacy rule-classifier vocab), `reconcileComponents`, `toOpenCageComponents`.
  - `key.ts`: `canonicalKey(components)` + `normalizeAddressToken` — the normalized,
    deterministic **match key** blocking collides on.
  - `corpus/src/format.ts` is now a thin re-export of this (~170 dup lines removed,
    `@fragaria` dep dropped from corpus). **`core/formatter` was intentionally NOT
    migrated** — formatter type-deps core's `ComponentTag`, so `core` depending on
    `formatter` would be a forbidden `tsc -b` reference cycle. Don't try it; the fix needs
    the schema types in a shared base (a separate refactor).

- **`@mailwoman/record`** (#600) — the canonicalize layer. Plain TypeScript interfaces
  only (operator decision: **no Nexus/TypeORM/JSON-schema machinery**; use Kysely if a DB
  is ever needed).
  - `address.ts`: `PostalAddress` (components + canonicalKey + optional `AddressGeocode`
    - formatted), `AddressGeocode` (mirrors mailwoman `GeocodeResult`: `ResolutionTier` +
      `uncertaintyMeters` + hierarchy + poBox/multiUnit flags), `toPostalAddress`,
      `withGeocode`.
  - `name.ts`: `parsePersonName` — rule-based positional parser (the python-nameparser
    recipe), comma-inversion, leading titles, trailing suffixes, surname **particle stored
    separately** (`de la Vega` to particle `de la` + family `Vega`), nickname extraction.
    Western/romanized only; does NOT map nicknames to roots (lossy/gendered — that belongs
    in the matcher as a fuzzy agreement level).
  - `organization.ts`: `canonicalizeOrganizationName` — Winkler designation-strip (`Acme
Corp` equals `Acme Corporation, LLC`), DBA split, ampersand to "and", intra-token
    period/apostrophe removal (`S.A.` to `sa`), leading-`The` drop. ISO 20275 ELF + cleanco
    designation list.

- **`@mailwoman/match`** (#601) — the matcher: block, score, cluster. Generic over the
  record shape `R` (no dep on `record`).
  - `comparators.ts`: `jaro`, `jaroWinkler` (verified vs canonical refs), `nameSimilarity`
    (compound-surname edit/LCS fallback for the J-W blind spot), `levenshteinSimilarity`.
  - `fellegi-sunter.ts`: `ComparisonLevel` (m, u, minSimilarity, maxKm), `Comparison<R>`,
    `similarityComparison`, `levelWeight` (log2 m/u), `priorWeight`, `probabilityFromWeight`
    (overflow-safe), `scorePair` (returns `{ weight, probability, contributions }`),
    `decide` (link/review/non-link). Also the `TermFrequencyAdjustment` hook.
  - `em.ts`: `estimateParameters` (Winkler EM — **label-free** m/u + lambda fitting),
    `agreementPattern`. The keystone: trains with NO ground truth.
  - `tf.ts`: `buildTermFrequencyTable` (on-the-fly relative freqs — no Census table),
    `withTermFrequency` (rare-value agreement counts more; `Vijayan` beats `Smith`).
  - `blocking.ts`: `geoCellKey` (generous neighbour-expanded lat/lon grid — the geo-first
    primary block), `exactKey`, `conjunction`, `block` (union of keys, deduped pairs,
    oversized blocks **reported** not silently dropped). `BlockingKey<R>`, `LatLon`.
  - `distance.ts`: `haversineKm`, `distanceComparison` (Splink DistanceInKMAtThresholds —
    bucket distance into FS levels), `DEFAULT_DISTANCE_LEVELS`.
  - `clustering.ts`: `cluster` (connected-components union-find; pairwise scores are
    non-transitive so this is a required distinct stage; threshold = precision/recall
    knob; over-merge caveat — centroid-linkage is the documented refinement),
    `representative` (most-complete record).
  - `pipeline.test.ts`: the block-score-cluster capstone.

- **`@mailwoman/registry`** (#604) — the application. Depends on match + record.
  - `types.ts`: `SourceRecord` (the messy row, normalized), `ResolvedEntity`, minimal
    GeoJSON types.
  - `resolve.ts`: `resolveEntities(records, config)` runs block-score-cluster with
    geocode-first defaults (`buildDefaultModel`: name+org+address-key+distance comparisons;
    `defaultBlockingKeys`: geo+canonical+phone+email) + optional `trainEM`.
  - `geojson.ts`: `toGeoJSON(entities)` to a QGIS Point FeatureCollection (recordCount,
    cohesion, name/org/address, geocode tier as properties).
  - `ingest.ts`: `parseCsv`, `ColumnMapping`, `ingestRows` (pure column-map + normalize),
    `GeocodeAddress` (the injected geocoder **seam**), `geocodeAddressVia` (the adapter
    that wires mailwoman's **real** parse+geocode into the seam; `RawGeocode` is
    structurally a `GeocodeResult` subset, so this package never imports the heavy runtime).

## Locked decisions (don't re-litigate)

1. **Home:** new workspaces in `sister-software/mailwoman` (not isp-nexus, not a fresh
   repo). isp-nexus holds the legacy "bones" we ported from
   (`isp-nexus/universe/mailwoman/contacts`, `/organization`, `/postal`).
2. **Matcher v1:** classical **Fellegi-Sunter core + EM (label-free)**, with models as
   _selective_ additions — NOT model-first, NOT heuristics-only. Evidence-backed.
3. **Schema:** plain TS interfaces, no ORM/JSON-schema generation. Kysely if a DB is needed.
4. **Address-first**, then org/contact normalization structured on top of it.

## Research grounding (3 adversarially-verified deep-research passes)

Key findings that shaped the build: (1) **FS + EM trains a calibrated matcher with ZERO
labels** — the exact wall the original effort hit. (2) **Config dominates the model** —
so the matcher is tunable and we didn't chase one model. (3) **Geography as the primary
blocking key** is documented production practice (Grab, Geo-ER). (4) **Geocode quality
weights the distance evidence** (NAACCR precedent). (5) Pairwise scores are
**non-transitive**, so clustering is mandatory. (6) **No mature TS/JS ER lib exists** —
greenfield. (7) Names: rule-based positional parse + separate particle; nickname = fuzzy
agreement level not a rewrite; Jaro-Winkler + edit/LCS fallback; TF-adjust = leave m,
lower u for rare values, computed on-the-fly. (8) **Org-name matching is a known evidence
gap** (PART B — cleanco/GLEIF/acronym/TF-IDF unverified) — our org canonicalizer is a
solid baseline; org _matching_ needs a follow-up pass. Full detail in
`project-record-matcher.md` memory.

## How to work here (gotchas)

- **Worktree push needs an explicit refspec** — the local branch is
  `worktree-record-matcher` but the remote is `feat/record-matcher-foundation`:
  `git push origin worktree-record-matcher:feat/record-matcher-foundation`.
- **Per-package verify** (the worktree is fully `yarn install`ed and buildable):
  `node_modules/.bin/vitest run <pkg>/`, `tsc -b <pkg>/tsconfig.json`,
  `prettier --write -u <pkg>/`. Use the parent checkout's binaries at
  `/home/lab/Projects/mailwoman/node_modules/.bin/`.
- **After adding a workspace:** add it to root `package.json` workspaces, `tsconfig.json`
  references, `vitest.config.ts` aliases, then `yarn install` (updates the lockfile — keep
  it clean for CI's `--immutable`).
- **The heavy geocoder (weights + situs/interp shards) is NOT in this worktree**, so the
  real end-to-end geocode run can't be unit-tested here — it's operator-verifiable via the
  CLI. That's why geocoding is an injected seam.
- Another agent was active on `eval/oa-offmap-pull` in the shared checkout during this
  shift — we stayed isolated in the worktree.
- **Docs under `docs/articles/` are linted as MDX** — backtick any raw angle brackets or
  braces in prose, or the pre-commit hook rejects the commit.

## Open work (prioritized)

1. **CLI command** `mailwoman registry <csv>` — construct the real geocoder (neural parse +
   resolver + shards) and inject it into `geocodeAddressVia`, then run
   ingest, resolve, GeoJSON on a dataset. Lives in `mailwoman/` (the CLI package, which
   already has `geocode-core.ts`). This is the operator-verifiable integration that makes
   it run on real clinic data — **grades the thesis against truth.**
2. **PR hygiene** — split #607 into reviewable PRs (it bundles #599/#600/#601/#604), run CI.
3. **LLM column-mapping** (#603) — infer the `ColumnMapping` from a header + sample rows.
4. **#600 tails** — vendor `carltonnorthern/nicknames` (nickname agreement level), a
   `Contact` record type, and the **org-matching follow-up** (acronym/expansion, DBA/alias,
   TF-IDF n-gram — needs a PART-B research pass).
5. **formatter follow-ups** — suffix/directional expansion via `@mailwoman/codex`, own
   templates (drop `@fragaria`).
6. **Clustering refinement** — centroid-linkage to damp connected-components over-merge
   (currently mitigated by geo-local blocking).

## The 14 commits

```
6576e4a2 docs(concepts): the north-star strategy
3047ee7f feat(formatter): scaffold @mailwoman/formatter (#599)
b8c8a803 refactor(corpus): consume @mailwoman/formatter (#599)
d9182b12 feat(record): PostalAddress address-spine (#600)
12701c27 feat(record): person-name parser + org-name canonicalizer (#600)
082e7db1 feat(match): Jaro/Jaro-Winkler comparators (#601)
9f9c1bbf feat(match): Fellegi-Sunter scorer (#601)
da587864 feat(match): EM estimation — label-free (#601)
7360a728 feat(match): term-frequency adjustment (#601)
330615b7 feat(match): geo-first blocking (#601)
fedc5917 feat(match): clustering (#601)
8b4e0213 feat(match): distance comparison (#601)
6659f61b feat(registry): resolveEntities + GeoJSON (#604)
d29ebec2 feat(registry): ingest layer (#604)
```

Plus the strategy doc `docs/articles/concepts/geocode-first-record-matching.mdx`
(`draft: true`). Memory: `project-record-matcher.md`.
