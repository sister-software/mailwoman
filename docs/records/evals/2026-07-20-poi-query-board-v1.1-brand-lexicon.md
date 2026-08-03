# POI query board v1.1 — brand lexicon wiring (spec §3.6, part 2 of the brand-lexicon work)

**Date:** 2026-07-20. **Command:** `mailwoman eval poi-board`. **Fixtures:**
`mailwoman/eval-harness/fixtures/poi-board.jsonl` (51 cases, committed — v1's 45 + 6 new brand
cases). **DB:** `/mnt/playpen/mailwoman-data/poi/poi-full.db` (the full 4-country build,
release 2026-05-20.0; regenerated `poi-taxonomy/data/brands.json` against this same db — see
below). **Resolver:** default FTS admin shard (`admin-global-priority.db`).

**Status: still report-only.** No floors this round either — the brand-lexicon wiring is new
enough (this PR) that a floor would just be laundering today's numbers. Floors remain a
follow-up once the operator reviews both v1 and v1.1.

## What changed since v1

Part 1 (#1201, on main) shipped the QID table + `lookupPOIBrand`/`resolveBrandName` + the
browser table factory, but nothing consumed them — every query still only ever matched
`@mailwoman/poi-taxonomy` categories. Part 2 (this PR) does three things:

1. **Dominance floor in the brand-table generator.** `build-brands.ts`'s `aggregateBrands` now
   drops a QID entirely when its modal name covers less than `--dominance` (default 0.5) of the
   QID's total rows — not just demotes the minority spellings out of the alias list the way the
   pre-existing noise floor does. Motivating case: `Q4835981` aggregated ~20 unrelated US
   chains (CVS 23.8%, Walgreens 11.8%, 7-Eleven 6.2%, …) under one Wikidata QID — a systematic
   mistagging upstream in Overture's data, not a chain with noisy alt-spellings. **Regenerated
   `brands.json` against the same `poi-full.db`: 315 QIDs clear `--min-rows` alone; the
   dominance floor drops 111 of those (systematic mistagging) to a final 204-brand table, with
   `Q4835981` confirmed absent.** A second run against the same db produced a byte-identical
   file (`diff` exit 0) — the floor doesn't disturb determinism. `BRAND_TABLE_VERSION` bumped
   0.1.0 → 0.2.0 (the generation semantics changed, even though the shape didn't).
2. **`kind-classifier`'s `POIPhraseMatch` gained `kind: "category" | "brand"` and an optional
   `wikidata`.** `matchPOISubject`/`createScorePOIQuery` are unchanged — neither ever read
   `categoryID` for its OWN meaning; both treat a match opaquely beyond `.confidence`. For
   `kind: "brand"`, `categoryID` carries the brand's canonical display name (not a taxonomy id)
   — the field is reused rather than adding a parallel `name` field, since nothing in
   `kind-classifier` interprets it; the caller (`mailwoman`'s `poi-intent.ts`) is the one that
   knows what `kind` means.
3. **`mailwoman`'s `poiTaxonomyLookup` became the union lookup.** Categories first (unchanged),
   then `lookupPOIBrand` (exact-phrase, no locale gating), then `@mailwoman/variant-aliases`'
   brand-kind slang (locale-gated) chained through `resolveBrandName` to recover a QID. On a
   phrase that matches both a category and a brand, **category wins** — the early return never
   even consults the brand table. No live collision exists in the shipped tables (checked: zero
   overlap between `taxonomy.json`'s synonym phrases/category ids and `brands.json`'s
   names/aliases), so this precedence is exercised structurally in tests, not against real data.
   `mailwoman` now depends on `@mailwoman/variant-aliases` (new workspace dependency).

The executor (`poi-executor.ts`) and the reader's brand k-ring search
(`resolver-wof-sqlite/poi-lookup.ts`, `brandWikidata` search — category unconstrained) already
existed from part 1's scaffolding; both were verified live, unchanged.

## v1.1 numbers

```
POI query board (spec §3.6) — v1, REPORT-ONLY (no floors yet) — db: /mnt/playpen/mailwoman-data/poi/poi-full.db
51 cases, 92.2% overall pass rate

  expect kind     n     pass    rate
  abstain           8      8    100.0%
  address           6      6    100.0%
  results          37     33    89.2%

result rows returned: 508
  gersID non-null rate: 100.0%
  ancestry present rate: 100.0%

nearest-distance distribution (km, results-cases with ≥1 result, n=33): min 0.03  p50 0.83  p95 7.96  max 9.42
```

## v1 → v1.1 delta

| metric               | v1 (45 cases) | v1.1 (51 cases) | delta                               |
| -------------------- | ------------: | --------------: | ----------------------------------- |
| overall pass rate    |         93.3% |           92.2% | −1.1pp (one new brand failure)      |
| abstain              |    7/7 (100%) |      8/8 (100%) | +1 case (the bare-brand abstain)    |
| address              |    6/6 (100%) |      6/6 (100%) | unchanged                           |
| results              | 29/32 (90.6%) |   33/37 (89.2%) | +4 results cases, +4 pass, −1.4pp   |
| result rows returned |           496 |             508 | +12 (the 5 brand+slang cases' hits) |

**5 of 6 new brand cases pass.** The 4 brand+anchor cases (`brand-us-01` Chevron/Houston,
`brand-fr-01` Crédit Agricole/Lyon, `brand-ca-01` Tim Hortons/Toronto — all pass; `brand-us-02`
Applebee's/Dallas — fails, below) + the locale-gated slang case (`brand-slang-01`, "mcdo" →
McDonald's under `fr-FR`, chained through `variant-aliases`, since "mcdo" is NOT one of
McDonald's own `brands.json` aliases — verified empty) + the bare-brand abstain (`brand-bare-01`,
"chevron" alone → `anchor_required`) all pass.

**No brand-vs-category collision case shipped** — the composition brief asked for one "if one
exists in the data." Checked directly: zero overlap between `taxonomy.json`'s synonym
phrases/category ids and the regenerated `brands.json`'s brand names/aliases. Skipped per the
brief's own fallback ("else skip, note").

## The one new failure: `brand-us-02` — Applebee's near Dallas, TX

```
[results] brand-us-02: "applebee's near Dallas TX"
    expected ≥1 result (brandWikidata=Q621532), got 0
```

Traced live — this is NOT a subject-match or anchor-resolution miss (both work correctly):
`matchPOISubject` resolves "Applebee's" → `Q621532` cleanly, and the anchor resolves to
`(32.79398, -96.765692)` — within ~4 km of the fixture's `anchorGold` (32.7767, -96.7970), a
good lock on Dallas. The miss is in the READER's k-ring search radius. `poi-lookup.ts`'s
`#searchKRing` defaults to `DEFAULT_MAX_RINGS = 12` res-9 rings, documented as "≈ ~4 km" — but
the nearest actual Applebee's row to the resolved anchor is **~13 km away** (confirmed via a
direct `poi.db` query: rows at 13.2, 20.4, 21.8, 24.2, 28.2 km). That's comfortably inside the
board's 25 km grading tolerance (which is deliberately city-scale — "roughly the right place",
per the v1 report) but well outside the reader's actual 4 km search radius.

This is a genuine execution-layer finding, the same class as v1's `supermarket`/`trail`
category misses: **brand rows are sparser per unit area than category rows** (one Applebee's
per few km² of a metro vs a "restaurant"/"cafe" hit almost anywhere), so a k-ring radius tuned
for category density under-reaches for a specific brand even in a market where the brand has
real, findable coverage. Left failing, not tuned away — worth a follow-up look at whether brand
queries should get a wider `maxRings` default (or the board's own grading tolerance should split
brand vs category, since 25 km papers over what a 4 km search radius can't reach).

## Runner notes

- Grading extension: `PoiBoardResultsExpect` gained an optional `brandWikidata` field alongside
  the existing (now-optional) `categoryID` — every fixture sets exactly one, enforced by a new
  fixture-set test. `gradeCase`'s results branch checks `results[0].brandWikidata` when
  `brandWikidata` is set, `results[0].categoryID` otherwise; the category branch's exact
  mismatch wording (`top category X !== expected Y`) is unchanged, keeping every v1 assertion
  green untouched.
- `gradeCase` + fixture-set tests: 26 tests, all green (`mailwoman/eval-harness/poi-board.test.ts`).
- Live CLI probe (`mailwoman poi "chevron near Houston" --db poi-full.db`) returns four ranked
  Chevron `convenience_store` hits, nearest 2.2 km. `--overpass` on a brand subject still emits
  `nwr["name"~"Chevron",i]` (unchanged from part 1). The bare `mailwoman poi "chevron"` (no
  anchor) abstains `anchor_required`, and `mailwoman poi "mcdo near Marseille" --locale fr-FR`
  resolves through the `variant-aliases` chain to McDonald's, two hits within 3.3 km.
- Exit code is still 0 regardless of case failures.

## Next steps (not this PR)

- Investigate whether brand k-ring searches should default to a wider `maxRings` than category
  searches (the `brand-us-02` finding above).
- Set floors off v1 + v1.1's combined numbers once the operator reviews them.
- v1's still-open items (`supermarket`/`trail` category coverage, Montreal/Calgary
  anchor-resolution homonym ranking) are unchanged by this PR.
