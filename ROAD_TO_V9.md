# ROAD_TO_V9 — the floor for the next model promotion and the next mailwoman major

Opened 2026-08-06 from the Run B / country-sweep / #1514 cycle. This document is the **floor**: the
set of things that must be true before (a) model v4.2.0 is promoted to the shipped lineage and (b)
the v9.0.0 release is cut. Items are tiered — A gates the model, B gates the release, C rides along
if ready and does not block. Each item carries its acceptance bar and the issue that tracks it.
The standing invariants (the D-rule above all: no default-on mechanism ships with a known regression
vs the shipped model on any tier-1 locale) apply to every item and are not restated per line.

Two decisions in this document are operator-ratified as of 2026-08-06 and recorded here so they do
not get re-litigated: **ranking is referential, not encyclopedic** (§2), and **v4.2.0 promotes with
conditions** rather than waiting on a retrain (§1).

---

## §1 — Tier A: promote model v4.2.0 (the anchor-cure base)

The evidence record is `docs/records/evals/2026-08-05-v420-base-anchor-v2-run-b.md` (#1508) and the
regression diagnosis (#1515). Cure proven: gb-golden 318/318 with the anchor channel fed; Fisher
mass on the GB slot 11.28% with CA/JP exact-zero controls; GB dependent_locality 0 → 205/207 under
the base package; US/FR parity up; int8 ↔ fp32 byte-identical.

Conditions, all satisfiable without GPU time:

| #   | Condition                                                                                                                                                                     | Bar                                                                                                         | Tracks                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------- |
| A1  | Re-grade the four territory rows (`pr-op3-venezuela-san-juan`, `vg-op3-road-town`, `vi-op3-chocolate-hole-cruz-bay`, `pr-op3-playa-sardinas-culebra`) to `improvement_target` | gauntlet gated legs green under v4.2.0 with the re-grade applied; the rows stay tracked, never deleted      | #1515's finding; rows' own notes |
| A2  | The weights assembly ships the card contract this model requires: `"requires": { "anchor": { "required": true, "span_mode": "shaped" } }`                                     | `createScorer` fails closed without it; a packaged-weights smoke proves the shaped keyer fires on gb-golden | recipe header's SHIP OBLIGATION  |
| A3  | Serving lexicons match training: the card names its lexicon versions and `resolveWeights` resolves from the card (v7 locality-surface, not the hard-coded v6 filename)        | a train/serve lexicon mismatch is a load-time error, not a silent downgrade                                 | #1510                            |
| A4  | The en-gb overlay ships the evidence-bundle lexicons its card claims, plus the new Code-Point `postcode-gb.bin` (1,749,839 keys, builder on #1508's branch)                   | overlay smoke: both evidence channels feed on GB input; the bin fires 106/120 on gb-golden                  | #1511                            |
| A5  | `gazetteer postcode-binary` refuses to write an empty (or below-floor) bin, and derives GB outwards by shape, not space-split                                                 | the #1509 reproduction exits nonzero with a named reason                                                    | #1509                            |
| A6  | Shaped span-mode is guarded against the lowercase register: the scorer refuses `span_mode: "shaped"` when case normalization is off, or the keyer case-folds                  | lowercase leg of gb-golden scores identically to as-written                                                 | #1512                            |

Recorded, **not** gating — the named lever for the next training run, whenever one happens:
`synth-gb` dose 6.0 → 3.0 and `countryFraction > 0` on that shard (800k country-less rows taught a
positional habit; see #1515). Do not retrain for this alone.

## §2 — Tier A/B: ranking is referential — the two-score split

Ratified policy: **"importance of a knowledge-base article ≠ probability this is the place the user
means." The geocoder ranks by referential likelihood.** Encyclopedic importance is carried as data,
never as the ranking key.

- **R1 (B):** the gazetteer and FST entry carry two fields: `referential` (population-anchored — the
  backbone) and `encyclopedic` (the Wikipedia join, fan-out-guarded per #1499). The decoder's bias
  reads `referential`. Saint-Denis is the canonical test: the hamlet (pop 202) must lose to the
  suburb (pop 96,128) with no hand rule involved.
- **R2 (C):** the blend weights, if any beyond population, are **fitted, not hand-set** — the
  Fellegi-Sunter construction from `match/` over (name-match, population-log, placetype-prior,
  admin-context, wiki-signal), evaluated on the §3 board. Rules-shaped scoring functions are the
  thing this project deleted in v7; we do not reintroduce one by the side door.
- **R3 (A for any FST swap):** no importance/FST change ships until the §3 board separates the
  arms. Today three arms (no FST / population FST / real-importance FST) score byte-identically on
  the OA board — an unmeasurable change is an unshippable change. Tracks #1497.
- One hard rule survives from the ranking discussion, as abstention doctrine rather than scoring: a
  bare query never resolves to an obscure feature type without declared ambiguity (§4).

## §3 — Tier A: the hard-slice board (the shared unblocking artifact)

One board, three consumers: the FST/importance gate (#1497), the intent work (§4), and the
suggestion layer's bars (#1489). Contents: bare city names (namesake-prone: the sweep's 45
family-C rows are seed material), comma-free fragments, homonym confounds
(Paris/Springfield/Washington classes), and the sweep's country-distinctive structures (42.9% hit
rate — the highest-yield class, measured against the draft's expectations in #1513).

Bar for the board itself: the three FST arms produce **different** scores on it (discrimination),
and it carries per-row declared tolerances with the meaning-of-zero discipline (a no-coordinate row
is absence, not zero). The 306-case corpus + `cases/generalization/` passes are the raw material;
the board is a curated slice, not another sweep.

## §4 — Tier C: query intent, pre-decoder

Intent lives where it always has: **before the decoder**, as vocabulary of the existing
kind-classifier — not a new stage. Extensions, in priority order:

1. `poi_category` — "tacos", "grocery store": the poi-taxonomy synonym table + poi.db are the
   lexicon and the answer set. Blocked only by the poi.db ancestry/gers_id debt already on the
   spatial-layers ledger.
2. `bare_toponym` — feeds §2's ranking and the declared-ambiguity path.
3. `route_pair` — "Paris London": two coherent toponyms, no address grammar between them. The
   correct v9 behavior is _classification + declared fork_, not a router.
4. `near_me` — preposition + no anchor → requires a focus point. Default: caller's focus if
   supplied (Photon already accepts one), else locale-country coarse bias; a focus-biased answer
   **says so** in its attribution.

Guessing doctrine (applies at every tier now): rank by referential likelihood; when the dominance
margin is thin (the measured 0.5 log10 line from the ablation-ladder work), return the winner with
declared ambiguity — the suggestion layer's nudge shape — and never resolve a bare query to an
obscure feature type silently.

## §5 — Tier B/C: coverage floor from the sweep

- **B:** the 45 namesake rows and 27 no-coordinate rows from #1513 stay tracked; the release notes
  state coverage honestly (the "what mailwoman does not cover" register).
- **C:** territory repair — PR/VI containment holes (#1503), dual-role places (#402), and a PR
  address shard (TIGER covers Puerto Rico; the corpus never ingested it). This is the data cure for
  the §1-A1 rows.
- **C:** the truncation family (#1519, 15 rows) — a span-boundary investigation with the sweep rows
  as its board.

## §6 — Tier B: instrument integrity

A release is gated by instruments; these are the known ways the instruments lie, and the floor is
that none of them can lie silently at release time:

| Item | Defect                                                                                                                              | Bar                                                                                                          | Tracks                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| I1   | Invariance runner measures the raw classifier, en-US for every row — scored Run B's gained GB capability as a loss                  | invariance runs the pipeline path with per-row locale, and the verdict shape gains a gained-capability class | #1516                                                |
| I2   | `expectPlaceID` / `expectPlaceName` stored but never checked                                                                        | wire into `checkCase` or delete the fields                                                                   | #1507                                                |
| I3   | `regression.db` can be silently rebuilt from a stale compiled tree ("built" from the deleted array — 2026-08-06)                    | the builder stamps the corpus hash into the DB; the runner refuses on mismatch with the live loader's hash   | circle-back note; same pattern as #1488's FST stamps |
| I4   | Missing `postcode-us.bin` silently costs 3–4 baseline gauntlet cases; the anchor-OFF log warning fires even when the bin is present | grading environments assert bin presence; the warning names its actual condition                             | #1516 (second half)                                  |
| I5   | Promoted-artifact swaps race CI on the shared data root                                                                             | CI takes a private symlink-overlay data root                                                                 | #1492                                                |

## §7 — Tier B: release mechanics

- The release rebuilds the shipped pair indexes at PIX schema 3 via `copy-weights` (readers refuse
  v1/v2 — this is the planned atomic cutover, verify it in the release smoke).
- `gazetteer publish` (#1494) is the coherent-bundle answer; for v9 the floor is the manual chain
  executed with the #1488 freshness stamps green — the tool itself is C-tier.
- Fold discipline post-#1514: `--fold` stays default-OFF; the release runbook's candidate step runs
  fold-free against the already-folded admin artifact.
- Fix the `corpus overlay-manifest` `--version` flag collision before anyone needs the tool during
  a release week (#1491), sweep AGENTS.md's workspace table (#1505), and close the candidate
  delivery-city gap (#1495) with the next candidate rebuild.
- FST artifacts with no builder (#1493): decide retire-vs-rebuild for `fst-global-priority.bin` and
  the CJK three before the release publishes stale binaries to HF again.

## §8 — Explicitly NOT the v9 floor

Named so their absence from the gate list reads as a decision, not an omission: the JP serving arc
(the 0.9928 char model has no serving path yet — its own arc), the suggestion-layer implementation
(bars preregistered in #1489; the ablation map and §3 board feed it), the FST importance **swap
itself** (gated behind §2 + §3, no urgency — the population proxy loses us nothing today), the
deletion-ablation extensions (#1503), and the postcode-structure arc's remaining slices (#1481 —
continues on its own preregistered bars).
