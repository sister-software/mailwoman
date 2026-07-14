# 2026-06-29 day shift — the constraint-graph arc

_A collaborative day that started as three namesake bugs and turned into an architecture. The throughline: stop guessing a country and let the gazetteer's own geometry decide where an address is — and when geometry ties, let the parser's recognition, not a hardcoded list, break it._

## What shipped

- **#832 — NYC, London, and the marquee-city namesake bug.** "New York, NY" was resolving to New York Mills (pop 3,190) over NYC (8.8M). The root cause was not the FTS ranking — NYC was in the window. It was NYC's WOF `parent_id = -4` (the multi-parent sentinel for a city straddling five boroughs), which left it only-self in the `ancestors` table, so the region hard-filter excluded it. The #441 `wof:hierarchy` backfill that fixes exactly this had never been wired into the rebuild pipeline, so the 2026-06-27 rebuild re-orphaned it. Fixed by wiring the backfill into `build-unified-wof` (PR #835) and swapping the repaired canonical DB. (PR #836 locked the gauntlet case to a gated pass.)

- **#833 — Portland, ME → Messina, Italy.** First diagnosed as a coarse-placer mis-prediction (GB 0.79), and a β-weighted posterior damp was built to correct it. Then the operator pushed back: a country safelist or a deterministic country-pin "borders on Pelias." That reframed the whole problem. The real fix is **joint geographic consistency** — resolve the (region, locality) pair where the locality descends from a same-named region candidate, because a "Portland" sits under Maine and not under Messina. No country prior, no list, and it generalizes to every country. Shipped as `opts.adminCoherence` (PR #837); the β-fusion was shelved on a spike branch. The two-consistent-pairs residual it can't reach (Augusta exists under _both_ Maine and Messina) is closed by a **derived** forward signal: `recognizeUsRegions` stamps `country_hint: "US"` on a 2-letter state abbreviation, and the resolver constrains that lookup to US (PR #838). Abbreviations only — a full "Georgia" stays ambiguous and is never pinned.

- **#266 — international coverage.** The #265 measurement found the off-map gap was coverage, not routing: the server gazetteer had **zero localities for ~147 countries** (Skopje, Tbilisi, Yerevan all absent). The night-2026-06-28 GeoNames `cities15000` fold had been staged but never promoted, and it predated #832. Reconciled the two (re-applied the ancestry backfill to the staged coverage DB), validated, and swapped it in: **97 → 244 countries, 2.97M → 3.74M localities**. Romanized off-map resolution went from 0% to ~80% (MK 84%, GE 79%, AM 90%, CY 64%), with the US path untouched.

## The decision that mattered: not building a model

#265 asked whether a supplementary forward address-system model was worth building. The measurement said no, and saying no was the win:

- The US two-pairs residual (Augusta) is small and rule-shaped — a derived `country_hint` closes it.
- The off-map international "0%" was a coverage hole, and a model cannot route to a place that isn't in the gazetteer.
- Covered international (JP/KR) already resolves 11/12 romanized.

No measured residual justified a learned model. The international lever was coverage (#266), which moved the number from 0% to 80% with data, not parameters.

## Disciplines that earned their keep

- **Verify before verdict** fired repeatedly: the #832 FTS hypothesis was wrong (it was ancestry); the β-fusion's "fixed 4/6" hid an arithmetic hole; the #265 off-map "0%" was coverage, not routing, and the spot-check caught it before a wrong conclusion shipped.
- **Test the numbers** caught two arithmetic holes in the DeepSeek-proposed β-fusion formula — discounting the argmax only trades Italy for England, and multiplying non-US mass by β can't lift US from zero. The structural advice held; the specific numbers needed a probe. (4-turn pro consult; structural 4/4, quantitative corrected twice.)
- **Diagnostic before fix** killed the forward model and redirected the effort to coverage.

## Numbers

|                    |                                                                  |
| ------------------ | ---------------------------------------------------------------- |
| PRs merged         | #835, #836, #837 (+ #838 in flight)                              |
| Canonical DB swaps | 2 (ancestry #832, coverage #266), both build-on-copy + validated |
| Coverage           | 97 → 244 countries; 2.97M → 3.74M localities                     |
| Off-map romanized  | 0% → ~80%                                                        |
| Gauntlet           | regression 9/9 gated, metamorphic unchanged, 0 new violations    |
| Models trained     | 0 (the day's one model question was answered "don't")            |

## Open / next

- **#838** merges to close the #833 family completely.
- **R2 deploy + B3 (#260):** the staged coverage _candidate_ table makes the win demo-visible in the browser, but the candidate path is denormalized (no `parentId` scoping), so adminCoherence needs a candidate-table change to reach the browser. `country_hint` already works there (the candidate lookup honors a country filter). An R2 deploy is operator-gated.
- **"Tbilisi, Georgia" (full-name country)** still mis-routes to US Georgia — the reverse namesake plus the coverage-added intl localities lacking parent ancestry. A #266 data-quality follow-up.
- **#261** (case-aug retrain, gate-failed) and **#259** (the dev-symlink that made the #261 gate baseline unfaithful) remain operator calls.

Design reference: [`plan/2026-06-29-joint-consistency-resolution.mdx`](../../plan/2026-06-29-joint-consistency-resolution.mdx).
