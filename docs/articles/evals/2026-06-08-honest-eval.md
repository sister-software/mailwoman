# The honest eval — when the metric graded by name and missed the wrong state

_2026-06-08. Self-emitted figures from `scripts/eval/honest-eval.sh` (#371 leakage-free
geographic split + #373 PIP-containment). Numbers are written by the harness, never hand-typed._

## Why a new yardstick

Every resolver number we have ever quoted shares a flaw: the eval set and the training corpus
cover the same places. A model that has seen Springfield, Illinois a thousand times in training
will "resolve" it on the eval — but that is recall of a memorized place, not generalization. And
the headline metric made it worse. We graded resolution by **locality name-match**: did the
resolved place carry the same name string as the gold? That question is blind to the failure that
actually matters — resolving the right *name* in the wrong *place*. "New York" matches "New York"
whether the point lands in Manhattan or in a village 280km upstate.

So this harness measures two things the old one could not:

1. **A leakage-free slice.** Evaluate only on OpenAddresses rows whose geography the training
   corpus held out (`corpus/src/split.ts` `defaultHoldouts()`: US = VT/WY/ND, FR = Corse/Lozère/
   Creuse). Those are places the model has never seen. In the current samples only **US/Vermont**
   clears a 1000-row trust floor (1428 rows); FR's held-out départements total 16 rows, and DE has
   no manifest holdout. We report VT and flag the rest honestly rather than scoring noise.
2. **A non-gameable metric.** Beyond name-match, report **region-match**, **coordinate error**
   (great-circle, gold point to resolved centroid, p50/p90), and **PIP-containment** — is the gold
   point inside the resolved WOF polygon. PIP is name-surface-independent: it rewards a
   geographically correct resolve even when WOF's canonical name differs from the gold's.

## What it found, immediately

The first run on the honest Vermont slice:

| metric | value |
| --- | ---: |
| locality name-match (the old, gameable number) | 93.7% |
| region-match | 0.0% |
| coord p50 / p90 (km) | 326 / 1827 |
| locality PIP-containment | 11.3% |

A 93.7% name-match next to a 326km median coordinate error is the whole argument for this harness
in one line. The resolver was finding the right *name* and the wrong *place* nearly nine times in
ten, and the metric we had been quoting could not see it.

### Root cause

The model is fine. It tags `region="VT"`, `locality="North Hero"`, the street, the number, and the
postcode cleanly. The resolver is where it breaks: WOF stores the state only as "Vermont", and the
`place_search` FTS index carried no USPS abbreviations, so `findPlace("VT")` returned nothing. With
no resolved region, the resolver's parent-constraint never engaged, the locality search ran
unconstrained across the entire US, and a higher-population namesake in another state won. "Sheldon"
has ten US localities; the population-5,455 one beats Vermont's population-932 one every time.

The abbreviation enrichment that would fix this **already exists** — `scripts/add-region-abbrevs.ts`
sources state/province abbreviations from the in-repo chromium-i18n libaddressinput data and writes
them into the `names` table, which `build-fts` folds into `place_search`. It was simply missing from
the build manifest's post-build step, so the deployed gazetteer was built without it (0 `abbr` rows).

### The fix, measured on the same slice

Running `add-region-abbrevs.ts` and rebuilding the FTS index, then re-measuring on the identical VT
slice:

| metric | baseline | abbrev-enriched |
| --- | ---: | ---: |
| region-match | 0.0% | **99.9%** |
| coord p50 (km) | 326.3 | **3.4** |
| coord p90 (km) | 1826.7 | **7.4** |
| locality name-match | 93.7% | 93.7% |
| locality PIP (all rows) | 11.3% | 29.7% |
| locality PIP (polygon-coverage-adjusted) | 15.1% | 47.1% |

Region resolution goes from broken to near-perfect; the median coordinate error collapses from
326km to 3.4km. Name-match does not move — confirming the model was always emitting the right name;
the fix makes the resolver pick the right *instance*.

Note the PIP-containment numbers. Even after the fix, locality-PIP is 29.7%, because 37% of the
correctly-resolved Vermont localities are WOF **point geometry** (no polygon can contain a point),
and WOF's small-town polygons are tight while OpenAddresses ascribes rural addresses to the town
they are nearest, not the town whose boundary encloses them. That is why the scorecard leads with
region-match and coordinate error — both checkable for 100% of rows — and reports locality-PIP only
alongside its polygon-coverage denominator. Raw locality-PIP would silently count un-PIP-able points
as failures.

## The catch — and why functional checks come before verdicts

The fix is not a clean win, and the demo presets caught why. On four populous US presets the
abbreviation enrichment moved region-match from 25% to 100% but **regressed locality name-match from
100% to 75%**, with one preset's coordinate error jumping to 283km:

> `350 5th Ave, New York, NY 10118` — baseline resolves "New York" (NYC); abbrev-enriched resolves
> "New York Mills", a village 283km upstate.

The mechanism is a second, deeper data gap. Once the region resolves, the resolver boosts candidates
that descend from it. New York Mills carries a full ancestry chain in WOF (locality → localadmin →
county → New York state → US). New York City's `ancestors` row contains **only itself** — its chain
to New York state is missing. So the region-descendant boost lifts the village and not the city, and
the village's boosted score overcomes the city's population. The region-abbreviation fix is
net-positive for well-parented rural places and net-negative for mis-parented metros.

The lesson the house already knew, re-earned: aggregate metrics agreed the fix was good (Vermont
went from 326km to 3.4km); the functional presets disagreed (NYC broke). When they disagree, the
functional check wins — and chasing the disagreement found the deeper bug.

## The resolution — repair ancestry from `wof:hierarchy`

The ancestry gap is a build artifact, not a source gap. NYC's source geojson carries a full
`wof:hierarchy` (region_id 85688543 = New York in every one of its five borough branches); it is
only `wof:parent_id` that is `-4`, and `build-unified-wof`'s parent_id-closure follows nothing but
parent_id. So `scripts/backfill-ancestors-from-hierarchy.ts` reads `wof:hierarchy` for every
only-self place and inserts the missing ancestor rows — repairing 47,129 places (+132,832 rows) in
the gazetteer.

Re-measured on the abbreviation-enriched **and** ancestry-backfilled gazetteer:

| slice | metric | baseline | abbrev only | abbrev + backfill |
| --- | --- | ---: | ---: | ---: |
| VT held-out (1428) | region-match | 0.0% | 99.9% | 99.9% |
| VT held-out | coord p50 / p90 (km) | 326 / 1827 | 3.4 / 7.4 | 3.4 / 7.4 |
| full-US (10k) | region-match | 14.2% | 99.9% | 99.9% |
| full-US (10k) | coord p50 / p90 (km) | 6.5 / **2763** | 3.3 / 10.3 | 3.3 / **10.3** |
| demo presets (4) | locality-match | 100% | 75% ⚠ | **100%** ✓ |
| demo presets | NYC resolves to | NYC | New York Mills ✗ | **NYC** ✓ |

The wrong-state error tail (full-US coord p90) collapses from 2763km to 10.3km, and the metro
regression is gone, with NYC resolving to New York City again. Net-positive on rural and metro.

Two things are worth saying about what this fix is. It is parser-agnostic: the harness runs both
the neural parser and the v0 (Pelias-style rules) parser through the same resolver, and the fix
lifts both from 0% region / ~330km coord to ~99.5% / ~3.3km. The bug lived in the gazetteer, not
the parser. And once the resolver is honest, the neural parser keeps its edge over v0 on geography
it never trained on:

| parser (VT, fixed DB) | locality | region | coord p50 | coord p90 | coord p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| neural | 93.7% | 99.9% | 3.4 | 7.4 | 277 |
| v0 (Pelias) | 91.9% | 99.5% | 3.3 | 7.2 | 2120 |

The medians tie; the neural parser's p99 tail (277km vs 2120km) is far tighter, which is the
beat-Pelias-on-the-hard-cases result we want on a held-out slice.

## Status

- The harness (`scripts/eval/honest-eval.sh`) + coverage-adjusted PIP reporter
  (`scripts/eval/pip-containment.py`) are the yardstick.
- The fix is two idempotent build steps — `scripts/add-region-abbrevs.ts` (already existed; was
  absent from the manifest) and `scripts/backfill-ancestors-from-hierarchy.ts` (new) — now wired
  into `scripts/wof-build-manifest.json`'s post-build, before FTS.
- The gazetteer fix is **validated on a copy** (`admin-abbrev-test.db`) but **not promoted to the
  canonical DB or the live demo** — that swap + R2 re-publish is the operator's call (a one-shot:
  run the two steps on `admin-global-priority.db`, rebuild FTS, rebuild the slim `wof-hot.db`,
  re-publish). The canonical DB is untouched.

## Next

1. Promote: run the two build steps on the canonical gazetteer, rebuild FTS + the slim demo DB,
   re-publish to R2 (smoke-test region-match ≥99.9%, coord p50 ≤5km after).
2. Fold the ancestry repair into `build-unified-wof`'s `populateAncestors` so a fresh build is
   correct without the post-build step.
3. Broaden the honest slice: a targeted OA re-ingest for FR's held-out départements, and a DE
   holdout in the corpus manifest, so region-match and coordinate error can be reported per locale.
