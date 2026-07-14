# Night shift 2026-06-28 — non-US recall levers (postmortem)

_Drafted during the shift; finalized at hand-off. Window: 05:32–14:15 UTC. CPU-only by design ($0 GPU)._

## What shipped (verified)

- **Phase 0 kill-switch (#826) fired** — and overturned the plan's primary hypothesis. The night was
  scoped to fold exonym/alt-names for ~97 "residual" countries. The probe
  (`scripts/eval/frontier-existence.ts`) measured exonym-only reliance at **1.0%**: the alt-name fold is
  already shipped (the 2026-06-27 build indexes the full GeoNames `alternatenames` set as name_key
  rows — Berlin carries 134+ surface forms). The real gap is **country-level absence**: 147 non-US
  countries had **zero** candidate rows. The 2026-06-26 frontier diagnostic that drove the plan ran
  admin-only and predates the fold, so it conflated "no candidate DB" with "no coverage."
- **B re-scoped to coverage expansion** (`scripts/build-coverage-expansion.ts`) — ingest **real
  per-country GeoNames dumps (village-level)** for the 147 zero-row countries via the SHIPPED pipeline
  (`foldGeonamesIntoAdmin` → `buildCandidate`), no package change, no model change. Staged DB:
  `candidate-global-coverage.db` (**10.14M rows, +988k places, +147 countries**; e.g. Albania
  395→16,647, Afghanistan 671→115,184). cities15000 is a download-failure fallback (0 used — all 147
  downloaded). Build-on-copy; canonical symlink untouched.

## Gate (against the staged DB)

- **do-no-harm: PASS.** Supported-set (US/ES/IT/NL/DE/FR) candidate row counts byte-identical
  canonical vs staged; parity harness supported 10/10 @ 4.6 km median with **per-query coords identical**
  (zero regression, even with +988k places).
- **did-it-help (existence): PASS.** `frontier-existence` on staged: country-absent **44.1% → 0.0%**,
  english-reachable **53.4% → 97.0%**, zero-coverage countries **91 → 0**.
- **did-it-help (coordinate): PASS.** frontier-gap staged vs canonical (same candidate-DB config):
  bare resolve-rate **41.7% → 75.3%**, +hint **51.0% → 94.1%**, residual countries **92 → 7**,
  bare-supported countries **77 → 150**, US-namesake misroutes **11.5% → 6.1%**. (The frontier samples
  top-3 cities, so it is equivalent to a cities15000-only build; the village dumps' added win is the
  long tail — smaller towns — the frontier can't see.)

**B gate: PASS on all three halves.** Staged at `candidate-global-coverage.db`; the canonical symlink
swap (`mailwoman gazetteer promote`) is the operator's morning call.

## Decisions made autonomously

- **Re-scoped the night's main work** from alt-name fold → coverage expansion, on the Phase-0 evidence.
  This is the kill-switch doing its job; the plan explicitly authorized it ("≤40% exonym → coverage
  expansion"). Recorded in `nightshift/2026-06-28-RESULTS/phase0-payload-decision.md`.
- **cities15000 as the coverage source** (vs downloading 147 per-country GeoNames dumps): present,
  deterministic, identical column layout, closes the major-city gap the frontier measures. Full
  village-level dumps are a documented follow-up.
- **Orchestrated the package functions directly** rather than re-running `mailwoman gazetteer build` —
  avoids re-folding the EU set into the wrong base and a synthetic-id collision; keeps the canonical
  geonames dir clean (synthesized `<CC>.txt` live in scratchpad).

## Phase D (#825) — MARGINAL (corrected — the first pass ran on a stale model)

Oracle-locality injection (PT/PL/AU, real-OA goldens, candidate backend). **First-pass error, caught by
verify-before-verdict:** `loadFromWeights` graded **v180** — the `neural-weights-en-us/model.onnx` dev
symlink points to v180 (a test side-effect), not the shipped v4.15.0 (v193a3). On v180 the model looked
disastrous (PT p50 47 / PL 116 / AU 798 km). **Re-run on the SHIPPED model**: PT **0.8 km**, PL **2.3 km**,
AU **1.2 km** median — already tight. No parse-accuracy disaster. The remaining gap is a **recall/p90
tail** (a perfect parse recovers PT +5 / PL +9 / AU +4 pp of unresolved), and **AU is gazetteer-bound**
(oracle ceiling 80.6%, Δp50 −2% → NO-GO). So **#825 is a marginal lever on the shipped model, not the
clean GO the v180 run implied** — frame any retrain as a tail/recall fix, and grade the shipped weights.
(The street-as-locality mechanism is real on v180 but largely absent in v4.15.0.)

## Phase C (#781) — measure-first killed the lever

Span-rescore is **+0.0 pp** on the staged-B candidate gazetteer across every EU locale. Coverage (the
alt-name fold + B) subsumed its recovery surface (resolved 97.9%), and the remaining EU gap is
mis-resolution (the #685 brake means span-rescore never fires on a resolved tree). No recovery triples →
no calibration to fit. **Recommend re-scoping/closing #781**; the EU lever is #825 (Phase D).

## Open questions (operator)

1. **Promote the staged B DB?** Gate PASSES all three halves (do-no-harm zero regression, existence
   44.1→0.0% absent, coordinate residual 92→7). 147 previously-unreachable countries become reachable,
   with village-level (full town) coverage. `mailwoman gazetteer promote` does the symlink swap; the
   demo/R2 re-stage is a separate follow-up.
2. **Phase A (placer): DATA GAP — defer to a class-set-widening retrain (branch-b).** The deployed
   placer is 28-class (US + EU-mostly); only CN/SK/LV of the 36 recoverable countries are classes
   (in_class_set false 31.6%). Crucially the placer is **99.6% correct at confidence 1.000 on its
   in-set countries** — so no threshold/M2 change helps; the only lever is adding classes (gated). And
   B already cut namesake misroutes 11.5% → 6.1% (the recoverable cities now resolve bare via
   population-first), so the placer retrain is lower-priority than it was.
3. **#825 (multilocale parse retrain) — likely NOT worth a GPU shift.** Corrected Phase D: the shipped
   model already resolves PT/PL/AU at a tight median (0.8 / 2.3 / 1.2 km); only a recall/p90 tail remains
   and AU is gazetteer-bound. AND the multilocale fix already exists as a trained, promote-ready artifact
   (v191, `out/v191/model.onnx`) — the shipped v4.15.0 (v193a3 anchor) is within ~1 km of it on PT. So the
   real #825 question is **promote v191 / combined anchor+multilocale retrain / leave** — an eyes-on
   decision, $0 new GPU tonight. See `nightshift/2026-06-28-RESULTS/gpu-finding-825-already-trained.md`.
4. **Re-scope or close #781 (span-rescore v2)?** Measure-first shows it is inert (+0.0 pp) on the
   candidate gazetteer. Keep only if wanted as an admin-only-backend safety net.

## Numbers

| metric                   | value                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------- |
| Shift window             | 05:32 UTC → (in progress)                                                               |
| GPU                      | $0 (CPU-only)                                                                           |
| Staged build             | candidate-global-coverage.db, 10.14M rows, +988k places, +147 countries (village-level) |
| Supported-set regression | 0 (per-query coords identical, +988k places)                                            |
| Peak heat                | 91°C (during VACUUM; cooled to 84°C between jobs)                                       |
| GeoNames dumps           | 147/147 target countries downloaded (real, village-level)                               |
