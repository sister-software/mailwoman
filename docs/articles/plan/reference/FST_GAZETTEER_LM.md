---
sidebar_position: 18
title: FST gazetteer language model
---

# FST Gazetteer LM

:::info Shipped
Phases 1-2 shipped in v0.5.2 ([#170](https://github.com/sister-software/mailwoman/pull/170), [#173](https://github.com/sister-software/mailwoman/pull/173)). Wikipedia importance integration in [#173](https://github.com/sister-software/mailwoman/pull/173). Unified SQLite builder in [#176](https://github.com/sister-software/mailwoman/pull/176). Phase 3 (autocomplete) partially shipped. Phase 4 (browser) not yet started.
:::

**Goal:** Pre-compute a finite-state transducer from the WOF SQLite gazetteer that maps token sequences → `(placetype, wof_id, parent_chain, importance)` entries. Use it as an emission prior in the neural Viterbi decoder, as a CLI introspection tool, and as the autocomplete backend.

**Principle:** Pay down the combinatorial cross-product of "all valid place-name paths through the WOF hierarchy" at build time. At query time, walking the FST is O(depth), not O(gazetteer_size).

### Shipped metrics (US admin)

| Metric                                        | Value          |
| --------------------------------------------- | -------------- |
| FST states                                    | 114,214        |
| Name insertions                               | 163,271        |
| Binary size                                   | 5.57 MB        |
| Load time                                     | ~10 ms         |
| Build time (from unified SQLite)              | 2.7 s          |
| Build time (unified SQLite from 293K GeoJSON) | 43 s           |
| Wikipedia importance matches                  | 47,348 places  |
| Population fallback                           | 108,111 places |

---

## Architecture overview

### The FST data structure

```ts
FstState {
  id: u32                              // dense index into states[]
  edges: Vec<FstEdge>                  // 2-5 entries avg
  places: Vec<PlaceEntry>              // accepting states only, 1-5 entries avg
}

FstEdge {
  token: string                        // interned, lowercase, NFKC-normalized
  target: u32                          // target state id
}

PlaceEntry {
  wof_id: u32                          // WOF numeric ID
  placetype: u8                        // PlacetypeId enum
  parent_chain: Vec<u32>               // [country_id, region_id, county_id?], leaf-to-root
  population: u32
  lat: f32, lon: f32
}
```

Tokenization is whitespace-split with punctuation stripping. The FST edge label is the normalized token. Accepting states carry ALL valid interpretations — "New York" ends at a state with entries for both NYC (locality) and NY state (region). The FST never picks; the neural model + reconciler do.

### Build pipeline

```
WOF SQLite (spr + names tables)
         │
         ▼
  fst-builder.ts  ← resolver-wof-sqlite/fst-builder.ts
         │
         ├─ Normalize names (NFKC, lowercase, strip punctuation)
         ├─ Tokenize each name + alt_names into token sequences
         ├─ Insert into incremental trie (shared prefixes)
         ├─ At each terminal: attach PlaceEntry
         ├─ Determinize + Minimize (Hopcroft)
         │
         ▼
  fst.bin  ← compact binary (~8-12 MB for US)
         │
         ▼
  FstMatcher class (fast prefix walk)
```

### Integration with the neural pipeline

The FST provides per-token emission biases, composing additively with the existing QueryShape soft prior:

```ts
let emissions = logits
if (opts?.queryShape) {
  emissions = addEmissionMatrix(emissions, buildEmissionPriors(...))
}
if (opts?.fst) {
  emissions = addEmissionMatrix(emissions, buildFstEmissionPriors(...))
}
// → Viterbi decode over biased emissions
```

The FST prior gets STRONGER as the prefix grows longer — a "wedge that tightens with information." A bare "S" spreads bias across many places; "San Fran" concentrates it on San Francisco.

### The WFST analogy to speech recognition

| Speech recognition            | Address parsing                             |
| ----------------------------- | ------------------------------------------- |
| Acoustic model (DNN)          | Neural classifier (transformer)             |
| Pronunciation lexicon (L)     | FST (token sequences → place entries)       |
| Language model (G)            | Address grammar (valid component sequences) |
| Shallow fusion at decode time | Additive emission biases at Viterbi time    |

The neural model handles non-gazetteer components (streets, venues, house numbers, typos). The FST handles gazetteer components (countries, regions, localities). They compose via shallow fusion — same as modern ASR systems.

---

## CLI proof-of-concept

### `mailwoman fst build`

```bash
mailwoman fst build --db /path/to/wof-admin-us.db --output fst-en-US.bin --countries US
```

### `mailwoman fst query`

```bash
mailwoman fst query 'New York' --fst fst-en-US.bin --show-continuations
```

Example output:

```
"new york" (complete match)
├── Accepts: 2 interpretations
│   ├── locality New York City    pop 8,804,000  wof:85977539
│   │   chain: US ← New York (state) ← New York (city)
│   └── region   New York State   pop 20,200,000 wof:85688543
│       chain: US ← New York (state)
└── Valid continuations:
    ├── "ny"    → region (NY state, disambiguated)
    ├── "10001" → postalcode
    └── [end]   → valid terminal
```

**Negative evidence example** — `'Buffalo Health Clinic, Buffalo'`:

```
"buffalo" → 14 places (locality Buffalo, NY is top)
"health"  → NOT IN FST (no gazetteer match)
  → Strong signal: this span is NOT an admin component
  → Fall back to neural model for typing (likely venue)
```

---

## Locale strategy

**Per-locale FSTs (recommended for v1).** One FST per locale: `fst-en-US.bin`, `fst-fr-FR.bin`. Filter by country during build. Names in all languages are included (a user typing "Munich" in an en-US context won't match — and that's correct, Munich isn't in the US).

| Locale | Places          | FST size |
| ------ | --------------- | -------- |
| en-US  | ~30K            | ~8 MB    |
| fr-FR  | ~36K (communes) | ~10 MB   |
| ja-JP  | ~1,800          | ~5 MB    |
| en-GB  | ~20K            | ~6 MB    |

### Why not combined+filter

A single FST with per-edge locale bitsets is space-efficient but query-slower. For v1, per-locale FSTs match the existing per-locale weights model. Revisit if multi-locale deployment becomes necessary.

---

## Size estimates

**Admin only (Phase 1):** ~8-12 MB for US. Smaller than the current 35 MB WOF slim DB but encodes more structural information (parent chains, population, valid continuations).

**With streets (Phase 2+):** ~200-500 MB for full US streets (3-5M unique street names). Too large for browser — shard per metro area (~5 MB each) for browser deployment. Server-side loads the full set.

---

## Implementation phases

### Phase 1: FST builder + CLI — shipped (#170)

- `resolver-wof-sqlite/fst-builder.ts`, `fst-matcher.ts`, `fst-types.ts`
- `resolver-wof-sqlite/fst-serialize.ts` (binary format, VERSION 2)
- `scripts/fst-query.ts` (interactive CLI)
- 24 integration tests against WOF US admin data

### Phase 2: Neural emission prior — shipped (#170, #173)

- `neural/fst-prior.ts` — `buildFstEmissionPriors()` with Wikipedia importance weighting
- `neural/classifier.ts` — FST threaded through `ParseOpts.fst`
- `core/pipeline/runtime-pipeline.ts` — FST threaded through `RuntimePipelineStages`
- Wikipedia importance ETL: `scripts/build-importance.ts`
- Region-aware locality bias guard: `neural/query-shape-prior.ts` (#174)

### Phase 3: Autocomplete prototype — partially shipped (#170)

- `resolver-wof-sqlite/fst-autocomplete.ts` — prefix walk + BFS expansion
- CLI not yet wired (standalone script only)

### Phase 4: Browser deployment — not started

- Browser-compatible FstMatcher (ArrayBuffer) not yet implemented
- `/demo` page does not use FST prior

---

## Key design decisions

1. **FST is an emission PRIOR, not a replacement.** The neural model remains the authority for non-gazetteer components. The FST handles what the model can't: knowing which place names exist and their hierarchies.

2. **Wikipedia importance-weighted bias when ambiguous.** Each place carries a [0,1] importance score derived from Wikipedia link count ([Nominatim methodology](https://nominatim.org/release-docs/latest/customize/Importance/)). "New York" biases both locality (0.95) and region (0.85) proportionally. Washington DC locality (0.815) correctly outranks Washington state (0.764) despite lower population. Formula: `importance × biasScale × maxBias` (linear, capped at 3.0 logits).

3. **Negative suppression on non-place labels.** When the FST matches a place name, B-street, I-street, B-house_number, I-house_number, and B-venue receive -1.5 logit suppression. This narrows the gap between place-tag and non-place-tag logits without overriding the model.

4. **Negative evidence is free.** When a token doesn't extend any FST path, that's a strong signal it's NOT an admin component — the neural model handles it alone. This is how "Buffalo Health Clinic" gets correctly NOT-biased toward locality.

5. **The FST eliminates reconciler beam search for admin components.** Only concordant paths exist in the FST. Invalid admin combinations were pruned at build time.

6. **Autocomplete is a prefix walk, not an index scan.** O(depth × branching) vs Elasticsearch's O(matches). The FST IS the autocomplete index.

---

## Relationship to existing architecture

The FST is the "pay-it-forward" implementation of the mail-carrier philosophy: each carrier's knowledge is pre-compiled into a structure that narrows the search space with each token consumed. The deliberative assembly (phrase grouper + neural model + reconciler) still adjudicates — the FST just gives them much better priors to work with.

Where the QueryShape soft prior says "this 5-digit token is probably a postcode" (structural pattern), the FST prior says "this token sequence matches 'New York' which is either locality WOF:85977539 or region WOF:85688543" (factual knowledge from the gazetteer). Both are additive biases; neither overrides the neural model.

## See also

- [`QUERY_SHAPE.md`](./QUERY_SHAPE.md) — the existing structural-prior system this extends
- [`DEMO_PRESET_DIAGNOSIS.md`](./DEMO_PRESET_DIAGNOSIS.md) — the locality/region confusion this addresses
- [`TRAINING_RECIPE_LEVERS.md`](./TRAINING_RECIPE_LEVERS.md) — training-side fixes (complementary)
- `docs/articles/understanding/exotic-poi/` — venue detection that benefits from FST negative evidence
