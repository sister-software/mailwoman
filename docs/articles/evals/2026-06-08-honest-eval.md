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
functional check wins. The abbreviation fix does not ship until the ancestry gap (or a bbox-based
region containment that does not depend on the ancestors table) lands with it.

## Status

- The harness (`scripts/eval/honest-eval.sh`) and the coverage-adjusted PIP reporter
  (`scripts/eval/pip-containment.py`) are the shippable deliverable — the yardstick now exists.
- The region-abbreviation enrichment is validated on a copy of the gazetteer but **not promoted**:
  it regresses NYC-class metros until the ancestry gap is addressed. Tracked as a follow-up.
- The build manifest's missing `add-region-abbrevs` step is documented; the manifest fix lands with
  the ancestry fix, not before, so a rebuild cannot ship the metro regression.

## Next

1. Repair the WOF ancestry gap (NYC-class only-self chains) in `build-unified-wof`, **or** add a
   bbox-based region containment so the region boost does not depend on the `ancestors` table.
2. Re-run `honest-eval.sh` on both the Vermont slice (rural) and the demo presets (metro) — the fix
   is promotable only when both improve.
3. Broaden the honest slice: a targeted OA re-ingest for FR's held-out départements, and a DE
   holdout in the corpus manifest, so region-match and coordinate error can be reported per locale.
