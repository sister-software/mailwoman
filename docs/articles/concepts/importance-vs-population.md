---
sidebar_position: 18
title: "Importance vs Population"
---

# Importance vs Population

Two signals in the resolver/FST distinguish "the famous one" from "the tiny same-name peer." They look similar but they're built from different sources and used at different layers.

## Quick reference

| Signal     | Table              | Unit                | Source                                                                | Coverage                                           | Where used                                       |
| ---------- | ------------------ | ------------------- | --------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| Population | `place_population` | raw count of people | WOF `wof:population` or `gn:population` GeoJSON property              | ~15% of localities                                 | Resolver `populationBoost`; FST builder fallback |
| Importance | `place_importance` | float [0, 1]        | Nominatim's `wikimedia-importance.csv.gz` joined via WOF concordances | Places with Wikipedia articles (varies by country) | FST builder primary signal                       |

## Build pipeline

**`place_population`** is built during the main WOF SQLite build (`scripts/build-unified-wof.ts`). When the script reads each WOF GeoJSON file, it pulls `wof:population` (preferred) or `gn:population` (fallback) from the `properties` block and stores it in `place_population.population`. No external download needed.

**`place_importance`** is built by a separate script (`scripts/build-importance.ts`) after the main DB exists. It:

1. Downloads `wikimedia-importance.csv.gz` from `nominatim.org/data/`.
2. Parses the TSV: `(language, title, importance_score, wikidata_id)`.
3. Joins to WOF via `concordances` table (`other_source = 'wd:id'`).
4. Writes one row per (WOF place, importance) match.

The Wikipedia importance score is derived from Nominatim's algorithm — Wikipedia article rank, language-spread bonuses, and curation flags. NYC scores ~1.0; an unincorporated hamlet scores 0 (no Wikipedia article).

## How they relate

When the FST builder loads importance scores, it follows this fallback chain (`resolver-wof-sqlite/fst-builder.ts:134-152`):

1. **If `place_importance` exists**: use it directly. Each WOF place gets an `importance ∈ [0, 1]` from Wikipedia.
2. **Else if `place_population` exists**: synthesize:
   ```
   importance = min(1.0, log2(1 + population/1000) / 14)
   ```
   A 1M-population city gets ~0.71, a 10K-population town gets ~0.24, missing population gets 0.
3. **Else**: importance = 0 for all places. FST still works, but ranking has no famousness signal.

This means the FST always ships a single `importance` field per place. The values are scaled but **not directly comparable** across the two paths — Wikipedia importance is a curated score, log-population is a structural proxy.

## Where each is used

### Population

- **Resolver `populationBoost`** (`resolver-wof-sqlite/lookup.ts:121`): adds `populationBoost * min(1, log10(1+pop)/6)` to the FTS5 candidate score. Default `populationBoost = 4.0`. Intentionally large to compensate for BM25's bias against famous places (their alt_names column inflates document length, hurting their BM25 score).
- **FST builder fallback** (above).

### Importance

- **FST place entry** (`resolver-wof-sqlite/fst-types.ts`): every accepted FST match carries an `importance` field. Consumers (autocomplete, query-shape ranking) sort by this.
- **`fst-autocomplete.ts`**: ranks suggestions importance-descending.
- **Neural model emission prior** (`neural/fst-prior.ts`): FST hits become BIO label biases; importance scales the bias magnitude.

## Why both exist

The resolver doesn't read `place_importance` directly — it operates one layer below the FST and uses population as its tiebreaker. This means:

- For **FST queries** (autocomplete, prefix matching, emission priors): importance dominates.
- For **resolver queries** (the post-classification step that picks "the actual place"): population dominates.

This is structural duplication, but the two signals are not redundant — they fail differently:

- A small but Wikipedia-notable village can have `importance > 0` and `population = NULL`.
- A large agricultural locality can have `population > 100K` and `importance = 0` (no English Wikipedia article).

## Known issues

### Resolver's BM25 length penalty

The resolver's `populationBoost: 4.0` exists because SQLite FTS5's BM25 normalizes by document length. The `place_search` table concatenates ALL multilingual name variants into a single `alt_names` column. Famous places have huge `alt_names` (NYC's is ~10K characters with 100+ languages); same-name peers have tiny `alt_names`. BM25 prefers the document with proportionally-more matches per token, which can rank a 50K-population impostor above an 8.8M-population real city.

**Attempts at column-weighted BM25** (`bm25(place_search, 1, 10, 1)` — name 10×, alt_names 1×) **don't fix this**: FTS5's doc-length normalization uses the row's total content length across all columns, not just the weighted ones. A row with bloated `alt_names` is penalized everywhere, even when scoring the `name` column in isolation.

The structural fix is to split `alt_names` into a separate FTS5 table with its own length statistics. Until then, `populationBoost: 4.0` is a tuning value that works for most cases but fails for the worst extremes (NYC vs West New York is the canonical example).

### Importance for non-English places

Nominatim's importance index is multilingual but biased toward languages with strong Wikipedia presence. Japanese localities have lower importance scores than population-equivalent US/EU peers because the JP Wikipedia is smaller. When v0.6.0 ships JP support, importance may need a JP-specific scaling pass.
