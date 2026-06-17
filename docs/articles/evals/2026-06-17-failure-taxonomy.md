# Failure taxonomy — where Mailwoman is wrong, and by how much (#375)

A standing map of the parser + geocoder's failure modes, each grounded in a **measured** number from a
named eval — not anecdotes, not vibes. The point is to make "where do we lose?" a table you can sort by
impact, so the roadmap is driven by measured gaps instead of the last thing someone noticed. Every row
cites the eval it came from; re-run that eval to refresh the number.

This is **v1** (2026-06-17), assembled from the eval corpus as it stands. It is meant to be living —
when an eval lands, update the row. Numbers dated 2026-06-17 are from this week's runs; older numbers
carry their eval's date so staleness is visible.

## How to read a row

`status` is the verdict of the source eval, not a wish:

- **fixed** — a shipped change moved the number and an eval confirms it.
- **open** — measured, unfixed, no committed fix.
- **deferred** — measured, a fix exists or was tried, and we consciously did not ship it (with a reason).
- **rejected** — a fix was built and the eval said it didn't earn its place.

The most important column is **lever / root cause**: it's what turns a number into a next step.

---

## 1. Input-shape failures

| class | measured | engine | status | lever / root cause | source |
|---|---|---|---|---|---|
| all-caps input | locality 90.1% → **99.7%** fixed (1172 TX facilities) | neural | fixed | OOD case (`PALESTINE`→`ALESTINE`); title-case detected all-caps before the model (#690, default-OFF) | 2026-06-17-geocoder-vs-provided-coords |
| intersection (`A & B`) | 82% correct structure (templated) | neural | open | ~1-in-6 trip; thin corpus coverage of the bare form | 2026-06-17-per-type-headtohead |
| quoted venue names | neural 74% vs v0 75% | both | open | neural over-extends the span; v0's `fieldsFuncBoundary` treats a quote as a wall | 2026-06-14-punctuation-stress |
| dotted abbreviations (`St.`, `123 1/2`) | v0 82% vs neural 74% | neural | open | neural absorbs the trailing token; v0 rules cut precisely | 2026-06-14-punctuation-stress |

The all-caps row is the week's clean win, but note its scope: it's fixed on the **resolveTree** path
(default-OFF opt). Wiring it into the record-matcher's geocoder is **deferred** pending an aggregate
artifact (#694) — see §4.

## 2. Locale / script failures

| class | measured | engine | status | lever / root cause | source |
|---|---|---|---|---|---|
| fr.house_number (postcode-first reorder) | 87.4% vs a 91% pre-registered floor | neural | deferred | positional shortcut learned on canonical data; the floor was mis-calibrated for the reordered case (SOTA ~90–91); weight falsified — needs real data, not another weight | 2026-06-13-fr-house-number-threshold-research |
| fr.region (golden dev) | 16.2% → 25.6% (v4.4.0) | neural | open | unfloored; FR has no real reordered data to train on | parity-scorecard-2026-06-11 |
| non-Latin / thin-coverage locales | in-map right-country ~26–35% (NL, KR) | neural | open | en-US-centric training; no locale-native eval set for non-Latin script | 2026-06-14-coarse-placer-arc-postmortem |

Locale is the deepest open frontier and the one least amenable to a code lever: the recurring finding
(fr.house_number) is that **weight tuning is exhausted** — the next move is real reordered/native data,
not another loss-mask or weight bump.

## 3. Format failures (po_box, intersection, unit, delimiters)

| class | measured | engine | status | lever / root cause | source |
|---|---|---|---|---|---|
| po_box (dotted leader) | 60% fail → 87% (span bridge) → 89% (separator exclusion) | neural | fixed | tokenizer dropped standalone punctuation; corrected at decode | 2026-06-11-v4.4.0-ship-gate |
| intersection (real TIGER shard) | 100% (real-OOD) vs 82% templated | neural | fixed | a real shard beats synthetic templates | 2026-06-11-v4.4.0-ship-gate |
| po_box / unit vs v0 | neural 100% / 100%; v0 **0% / 0%** | v0 | fixed-neural | v0 has no `po_box`/`unit` tag — the negative-space win | 2026-06-17-per-type-headtohead |
| cedex (FR real) | 96% (v4.4.0) | neural | fixed | deterministic regex path moved into the model | 2026-06-11-v4.4.0-ship-gate |
| paired-delimiter span proposer | −3.9pp vs 77% baseline | neural | rejected | the Stage 2.7 proposer's annotation bias has the wrong sign (merges where it should strip) — did not earn revival | 2026-06-14-punctuation-stress |

This is Mailwoman's strongest quadrant: the structured types (po_box, unit, intersection, cedex) are
either fixed or a rout against the rules engine. The one rejected fix (paired-delimiter proposer) is a
useful negative result — the eval gate stopped a plausible-but-wrong revival.

## 4. Geocoder coverage / accuracy

| class | measured | engine | status | lever / root cause | source |
|---|---|---|---|---|---|
| admin-centroid fallback | ~40% of TX facilities fall back (p50 3.4 km, p99 catastrophic) | resolver | open | **coverage**, not precision — no rooftop/interp shard hit on the parsed street | 2026-06-17-geocoder-vs-provided-coords |
| rooftop (address_point) tier | fires 47%; **0.7 km** p50 where it fires | resolver | open | coverage is the frontier — accuracy is solved when a shard has the point | 2026-06-17-geocoder-vs-provided-coords |
| interpolation (street) tier | fires 12.5%; **0.1 km** p50; raw radius covered only 72% → ×1.70 for a true 90% bound | resolver | fixed (radius) | a radius is decoration unless calibrated (#374) | 2026-06-14-interp-radius-calibration |
| off-map country routing | 88→ clears 90/90 (decision rule, no retrain) | resolver | fixed | `1 − P(OTHER)` in-map mass beats softmax argmax | 2026-06-14-coarse-placer-arc-postmortem |
| in-map wrong-region misroute | **0 / 2000** across 10 countries | resolver | fixed | the soft prior re-rank never misroutes (tier-safe) | 2026-06-14-coarse-placer-arc-postmortem |

The headline: where the finer tiers fire, the geocoder is rooftop-accurate (0.1–0.7 km, calibrated). The
open problem is **coverage** — ~40% fall back to a city centroid for lack of a shard. That's a data lever
(more situs/interpolation shards), not a model one. See the companion concept note on coordinate
sufficiency ("How close is close enough?") for what these tiers are *worth* per use-case.

## 5. Parity gaps & boundary instability

| class | measured | engine | status | lever / root cause | source |
|---|---|---|---|---|---|
| us.street (golden dev) | 75.5% → 77.9% (below the 80% bar) | neural | open | street-eats-affix boundary wobble; #511 helped affixes but didn't fully recover street precision | parity-scorecard-2026-06-11 |
| us.locality (golden dev) | 60.1% → 75.7% (below 80%) | neural | open | improving, but still under the canonical bar — note it *beats* v0 on OA-clean (§6) | parity-scorecard-2026-06-11 |
| perturb arena (noisy/glued) | 64% vs 71% (v4.2.0); floor restored to 72 in v4.4.0 | neural | partially-fixed | glue perturbation (`NY14201`) + post-directional wobble — the same boundary-instability family | 2026-06-11-v4.4.0-ship-gate |

The connective tissue across §1, §5: **token-boundary instability** (street eats affix, region+postcode
glue, directional wobble, dotted-abbreviation absorption) is one failure *family* surfacing under many
names. It's the most leveraged single area — a boundary-aware decode lever would touch several rows.

## 6. The inverse — capability asymmetries (wins worth defending)

| class | measured | winner | note |
|---|---|---|---|
| multi-word locality | neural 90.0% vs v0 84.7% | neural | +5.3pp — this week's per-type finding |
| directional street | neural 87.2% vs v0 85.2% | neural | +2.0pp |
| noisy / degraded input | neural 60% vs v0 39% | neural | +21pp; v0 shatters on quotes |
| graceful degradation (unbalanced delimiters) | neural 82.5% vs v0 68.3%, 0 parse deaths | neural | v0 throws; neural degrades |
| within-token punctuation (`O'Brien`, `St.`, `123 1/2`) | v0 89/87/72% vs neural 81/81/62% | **v0** | the standing neural weakness — v0's rules cut precisely where neural absorbs |

The capability map is not "rules vs ML, ML wins." It's: neural owns structure, robustness, and the
negative-space tags (po_box/unit); v0 still owns precise within-token punctuation. The last row is the
honest open edge — the clearest place a rule-assist or a punctuation-aware decode could close a measured
gap.

## Unmeasured (so we don't fabricate a number)

- **Apostrophe-in-token root cause** — v0 wins 89 vs 81, but no tokenizer trace explains why.
- **Natural intersection frequency** — templated 82%; real-world deployment rate unknown.
- **Cross-locale org-name variants** (DBA, nicknames, expanded designations) — flagged as record-matcher
  follow-up; no parser failure rate measured.
- **fr venue / region (#330)** — marked open on the scorecard, but no current benchmark number.

## What the table says about the roadmap

1. **Boundary instability is the highest-leverage parser lever** — it's one family (§1 dotted, §5 street/glue, §6 within-token) under many names; a boundary-aware decode would move several rows at once.
2. **Geocoder accuracy is solved; coverage is the frontier** — the ~40% admin fallback is a shard-data problem, not a model one (§4).
3. **Locale is a data problem, not a weight problem** — fr.house_number falsified weight tuning; real reordered/native data is the only remaining lever (§2).
4. **The eval gate earns its keep** — the rejected paired-delimiter proposer (§3) and the deferred geocoder wiring (§4, #694) are both cases where a plausible change was stopped by a measured regression. Keep grading the assembled output, not label-F1 (the #566 discipline).

_Sources: all rows cite a dated eval under `docs/articles/evals/`. Re-run the named eval to refresh._
