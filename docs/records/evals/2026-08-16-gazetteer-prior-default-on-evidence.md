# Gazetteer FST prior — default-on evidence (#1497)

**Date:** 2026-08-16 · **Decision:** promoted to default-ON, operator-approved · **Flag:** `gazetteerPrior`

The emission prior built from the per-locale gazetteer FST (`fst-<locale>.bin`) now feeds the parse by
default on the geocode path. `--no-gazetteer-prior` (parse/geocode) and `--gazetteer-prior-off` (eval
gauntlet) opt out.

## What had to be fixed before the measurement meant anything

Two defects made every prior-on number taken before this date wrong, both found on 2026-08-16 and
fixed in separate PRs.

1. **The session never fed the prior to the parse that happened** (#1699). `createGeocodeSession`
   built the FST and passed it to `geocodeAddress`, but that path parses ONCE up front and hands the
   tree over as `parsedTree`, so `geocodeAddress` never re-parsed and its copy was dead. Bare `Moscow`
   read as `street` with the flag on and off alike.
2. **The gauntlet fed every overlay the BASE classifier's FST** (#1703). A GB row ran en-GB weights
   against the en-US gazetteer — a pairing production never runs. `st margarets hope` is in
   `fst-en-gb.bin` and absent from `fst-en-us.bin`, so the row the lever fixes was invisible.

## Evidence

### Gauntlet, all layers, both arms

| layer       | prior OFF               | prior ON                |
| ----------- | ----------------------- | ----------------------- |
| regression  | 352/354 gated           | **353/354** gated       |
| metamorphic | PASS (3 tracked xfails) | PASS (3 tracked xfails) |

Row-level diff over all failing rows (gated + tracked), 209 OFF and 208 ON:

- **fixed: 1** — `gb-op2-st-margarets-hope`, `street` → `locality`
- **broken: 0**
- **US or FR rows changed: 0**, in either direction

### Parity corpus, 321 fixtures

Wired for this decision — until then the lever was reachable only from the gauntlet, which is #1497's
title verbatim ("FST decoder bias is invisible to every live eval").

| metric                                  | en-US OFF → ON    | fr-FR OFF → ON    |
| --------------------------------------- | ----------------- | ----------------- |
| house_number / postcode / street floors | identical         | identical         |
| spurious `street`                       | **13/54 → 10/54** | identical         |
| full agreement, US bucket               | **54/99 → 57/99** | 54/99 → **53/99** |
| full agreement, AU bucket               | 9/20 → 10/20      | identical         |
| full agreement, FR bucket               | identical         | identical         |

The three spurious streets it stops emitting are `Perth`, `Dallas` and `California`.

**Every floor tally is byte-identical in all four runs.** The prior's entire effect lands in the
PRECISION half that `parity-corpus.ts` documents the floors structurally cannot see — _"a tag emitted
where the gold has NONE costs nothing, forever."_ A floors-only reading reports "no change" and misses
both the gain and the loss, which is why this promotion rests on the full-agreement and spurious
columns.

## The D-rule (iron rule 6)

Tier-1 is US and FR.

- Under **en-US** weights: US +3 full-agreement, spurious street −3. No regression.
- Under **fr-FR** weights: the FR bucket is unchanged. The −1 is the **US bucket parsed with FR
  weights** — a configuration production does not route.

No tier-1 regression in any shipping configuration. The residual −1 is carried deliberately and named
here rather than waived: since every floor is identical in that run, the row moved on a NON-FLOOR tag
(locality, region or country), which is exactly where a gazetteer prior acts. It was not isolated to a
named row; an independent reimplementation of parity's full-agreement rule did not reproduce it, so
what is reported is parity's own metric.

## The objection this had to answer

The register's `fst` row records that the pipeline ships the street-context gate with the emission
prior **zeroed**, because ungated it measured **US-golden −48**. That number is about the
**street-morphology** prior (`ZEROED_MORPHOLOGY_OPTS`), not the gazetteer FST, and it is unaffected
here: `geocode-core.ts` already calls `streetContextGateFor` — the same helper `runPipeline` calls, on
purpose, so the two paths cannot drift (#1669) — so both ship `fstStreetContextPositiveScale = 0`
identically. Turning the gazetteer prior on does not re-open the morphology question.

## Bounds

The lever is now visible to the gauntlet and to the parity corpus. It remains invisible to
`eval error-analysis`, the coordinate panels and the golden per-tag evals, so "no known regression" is
bounded by those two batteries. Closing that is the remainder of #1497.

Five shipped overlays still carry no FST at all (`es-es` and `it-it` were built 2026-08-16 but are
staged, not promoted; `en-au`, `en-in`, `en-nz` have none), so the prior is inert for them and the
gauntlet now says so out loud per locale. See #1705.
