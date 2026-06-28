# Night shift 2026-06-28 — non-US recall levers (postmortem)

_Living document — sketched during the shift. Window: 05:32 UTC → (in progress). CPU-only by design ($0 GPU)._

## What shipped (verified)

- **Phase 0 kill-switch (#826) fired** — and overturned the plan's primary hypothesis. The night was
  scoped to fold exonym/alt-names for ~97 "residual" countries. The probe
  (`scripts/eval/frontier-existence.ts`) measured exonym-only reliance at **1.0%**: the alt-name fold is
  already shipped (the 2026-06-27 build indexes the full GeoNames `alternatenames` set as name_key
  rows — Berlin carries 134+ surface forms). The real gap is **country-level absence**: 147 non-US
  countries had **zero** candidate rows. The 2026-06-26 frontier diagnostic that drove the plan ran
  admin-only and predates the fold, so it conflated "no candidate DB" with "no coverage."
- **B re-scoped to coverage expansion** (`scripts/build-coverage-expansion.ts`) — ingest cities15000 for
  the 147 zero-row countries via the SHIPPED pipeline (`foldGeonamesIntoAdmin` → `buildCandidate`), no
  package change, no model change. Staged DB: `candidate-global-coverage.db` (9.17M rows, +147
  countries). Build-on-copy; canonical symlink untouched.

## Gate (against the staged DB)

- **do-no-harm: PASS.** Supported-set (US/ES/IT/NL/DE/FR) candidate row counts byte-identical
  canonical vs staged; parity harness supported 10/10 @ 4.6 km median with **per-query coords identical**
  (zero regression). Staged adds only +18,898 rows, all in the 147 new countries.
- **did-it-help (existence): PASS.** `frontier-existence` on staged: country-absent **44.1% → 0.2%**,
  english-reachable **53.4% → 97.0%**, zero-coverage countries **91 → 1**.
- **did-it-help (coordinate): PASS.** frontier-gap staged vs canonical (same candidate-DB config):
  bare resolve-rate **41.7% → 75.5%**, +hint **51.0% → 94.1%**, residual countries **92 → 6**,
  bare-supported countries **77 → 150**, US-namesake misroutes **11.5% → 6.1%**.

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

## Open questions (operator)

1. **Promote the staged B DB?** Gate passes do-no-harm + existence; coordinate confirmation pending.
   147 previously-unreachable countries become reachable with zero supported-set regression.
2. **Phase A (placer): DATA GAP — defer to a class-set-widening retrain (branch-b).** The deployed
   placer is 28-class (US + EU-mostly); only CN/SK/LV of the 36 recoverable countries are classes
   (in_class_set false 31.6%). Crucially the placer is **99.6% correct at confidence 1.000 on its
   in-set countries** — so no threshold/M2 change helps; the only lever is adding classes (gated). And
   B already cut namesake misroutes 11.5% → 6.1% (the recoverable cities now resolve bare via
   population-first), so the placer retrain is lower-priority than it was.

## Numbers

| metric | value |
| --- | --- |
| Shift window | 05:32 UTC → (in progress) |
| GPU | $0 (CPU-only) |
| Staged build | candidate-global-coverage.db, 9.17M rows, +147 countries |
| Supported-set regression | 0 (per-query coords identical) |
| Peak heat | 91.2°C (during VACUUM; cooled to 84°C) |
