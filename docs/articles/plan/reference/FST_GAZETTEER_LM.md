---
sidebar_position: 18
title: FST gazetteer language model
---

# FST Gazetteer LM — Design Document

**Goal:** Pre-compute a finite-state transducer from the WOF SQLite gazetteer that maps token sequences → `(placetype, wof_id, parent_chain)` entries. Use it as an emission prior in the neural Viterbi decoder, as a CLI introspection tool, and as the autocomplete backend.

**Principle:** Pay down the combinatorial cross-product of "all valid place-name paths through the WOF hierarchy" at build time. At query time, walking the FST is O(depth), not O(gazetteer_size).

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

| Speech recognition | Address parsing |
|---|---|
| Acoustic model (DNN) | Neural classifier (transformer) |
| Pronunciation lexicon (L) | FST (token sequences → place entries) |
| Language model (G) | Address grammar (valid component sequences) |
| Shallow fusion at decode time | Additive emission biases at Viterbi time |

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

| Locale | Places | FST size |
|---|---|---|
| en-US | ~30K | ~8 MB |
| fr-FR | ~36K (communes) | ~10 MB |
| ja-JP | ~1,800 | ~5 MB |
| en-GB | ~20K | ~6 MB |

### Why not combined+filter

A single FST with per-edge locale bitsets is space-efficient but query-slower. For v1, per-locale FSTs match the existing per-locale weights model. Revisit if multi-locale deployment becomes necessary.

---

## Size estimates

**Admin only (Phase 1):** ~8-12 MB for US. Smaller than the current 35 MB WOF slim DB but encodes more structural information (parent chains, population, valid continuations).

**With streets (Phase 2+):** ~200-500 MB for full US streets (3-5M unique street names). Too large for browser — shard per metro area (~5 MB each) for browser deployment. Server-side loads the full set.

---

## Implementation phases

### Phase 1: FST builder + CLI (Week 1)

New files:
- `resolver-wof-sqlite/fst-builder.ts` — `buildFstFromWof(db, opts): FstBinary`
- `resolver-wof-sqlite/fst-loader.ts` — `FstMatcher` class (walk, accepting, continuations)
- `resolver-wof-sqlite/fst-builder.test.ts`
- `mailwoman/commands/fst/build.tsx`
- `mailwoman/commands/fst/query.tsx`

### Phase 2: Neural emission prior (Week 2)

Modified files:
- `neural/query-shape-prior.ts` — add `buildFstEmissionPriors()`
- `neural/classifier.ts` — add `fst?: FstMatcher` to config, compose in `parse()`

New files:
- `neural/fst-prior.test.ts`

### Phase 3: Autocomplete prototype (Week 3)

New files:
- `resolver-wof-sqlite/fst-autocomplete.ts`
- `mailwoman/commands/fst/autocomplete.tsx`

### Phase 4: Browser deployment (Week 4)

Modified files:
- `resolver-wof-wasm/fst.ts` — browser-compatible FstMatcher (ArrayBuffer)
- `docs/src/pages/demo/index.tsx` — load FST, typeahead UI

---

## Key design decisions

1. **FST is an emission PRIOR, not a replacement.** The neural model remains the authority for non-gazetteer components. The FST handles what the model can't: knowing which place names exist and their hierarchies.

2. **Population-weighted bias when ambiguous.** "New York" with two interpretations biases both proportionally to population. The neural model's context breaks the tie.

3. **Full bias when deterministic.** When the FST narrows to one interpretation (e.g., "Portland" + "OR"), the bias is maximal.

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
