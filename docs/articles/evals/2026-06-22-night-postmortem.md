# Night shift — 2026-06-22 (eval-coverage force-multiplier → gated FR training stretch)

_Living document — sketched during the shift, finalized at hand-off (15:00 UTC). Plan: `nightshift/2026-06-22-NIGHT-SHIFT-PLAN.md`. The arc: a 4-turn DeepSeek consult set the next major effort as a two-phase eval→capability arc; tonight builds Phase A (non-US/fine held-out eval coverage, #229) and rides the corrected FR levers as a gated GPU stretch._

## What shipped

- **#229 Phase-A scorecard — `docs/articles/evals/2026-06-22-fr-eval-coverage-scorecard.md`.** Graded the production model (v1.8.0) per-locale per-tag with support-size reliability flags + a failure taxonomy + a data-acquisition plan. The honest read: FR reliable floors hold (postcode 99.7 / house_number 99.6 / street 90.1 / locality 86.4); the real coordinate-relevant FR gap is **région recall 34.7%** on OOD formats (not country, which is precision-bound + coordinate-invisible); **venue (n=1) and unit (n=0) are unmeasured**, not failing — an absence of FR test data, not a model verdict.

### Levers retired with evidence (verify-before-verdict — stops re-attempts)

- **#734 EU bilingual-alias fold → RETIRED (no-op).** Extending the shipped FI GeoNames-alt-name fold to AT/SK then the full EU tail (PL/CZ/NO/HR/SI/LT/LV/EE/DK/BE/CH/LU/PT…) added **+0 aliases everywhere** — every GeoNames populated-place name is already present in the 20-series candidate (built from GeoNames allCountries, #182). So the candidate's EU **name** coverage is comprehensive; the AT 74% / SK 78% residual recall is **depth (sub-localities/districts) or eval-format artifact** (cf. the LT genitive-suffix artifact), NOT missing names. The FI fold was a genuine special case, now spent. Next real lever for EU depth = an Overture admin sub-division source or an eval-format correction, not GeoNames alt-names.
- **GPU training stretch (T1/T2) → NO-GO tonight ($20 unspent).** T1 (fr.country precision) is coordinate-invisible (resolver sources country from the placer, never the model tag); T2 (FR venue) is data-blocked (no FR POI on disk). Neither clears the coordinate bar with on-disk data. Reasoning in the scorecard's "GPU decision."
- **#564 FR house_number → confirmed model-side.** No FR address-point/interpolation coverage on disk (only `address-points-us-*`), so the resolver-side street-centroid fallback can't fire for FR — the lever is model/research, not a hostable-data win.

## Decisions made autonomously

- **v1.8.1 — gated → SHELVED (not promoted).** The shelved country-shard (`out/v181`, trained 06-19 to close v1.8.0's fr.country −3.5) was gated v180-vs-v181 on the real harnesses before the shift opened. **FR coordinate gate** (`fr-admin-split-gate.ts`, 3000-row disjoint-commune golden): p50 identical (2.17 km), mean −5.35 km (tail noise), région-correct +0.28 — *looked* like a clean promote. **Per-tag `per-locale-f1`** (anchor+gaz fed; v180 reproduced the postmortem's v1.8.0 FR numbers, so the setup is valid): fr.country moved **+0.4 only** (58.7→59.1, still 3.6 below the v1.5.0 baseline it was built to recover) while costing **US street −1.3, US locality −0.9, US exact −31, FR exact −10**. Net: a broad small label regression for nothing the median coordinate sees. **Root cause — the lever was aimed wrong: FR country F1 is precision-bound, not recall-bound** (the model over-emits country — FR recall ~96%, precision ~43%, hallucinating country on golden rows with no country token). The v0.8.1 "mix in rows carrying France" shard pushes recall↑/precision↓, so it can't lift F1 — **the country-bearing-shard hypothesis is falsified.** v4.11.0 (=v1.8.0) stays the production default. Artifacts: `/tmp/reg/{gate-v18*.json,pl-v18*.json}`.
  - **Why this is the night's keystone, not a footnote:** the FR coordinate gate *alone* would have shipped this regression. Only the per-tag held-out tripwire caught it — which is exactly the thesis of tonight's PRIMARY (#229: build the held-out eval that gates the capability decision). The shelved-artifact "free win" the consult pointed at dissolved on contact with measurement; the consult's deeper call (eval-first) is what caught it. The corrected lever (teach country *suppression*, a precision fix) rides as GPU-stretch T1.

## #229 lever 1 — FR-fine held-out stratum (the night's unlock)

**Audit of the existing FR golden (`data/eval/golden/v0.1.2/fr.jsonl`, 1551 rows) — what's actually under-measured:**

| component | FR rows | US rows | read |
| --- | --: | --: | --- |
| locality / postcode | 1537 / 1262 | 1792 / 1695 | well-covered |
| street / house_number | 665 / 665 | 2216 / 1031 | covered |
| region | 219 | 2956 | **thin** (model F1 43.3 on 219 rows — unreliable floor) |
| venue | **1** | 1075 | **unmeasured** (the "0%" is on a single row) |
| unit | **0** | 2 | **absent** for FR |

So the build targets, in priority order: **venue** (unblocks GPU-stretch T2), **region thickening** (firms T1's gate), then **unit** if a real source exists. Discipline: REAL data only (BAN/OA + Overture POIs + codex `departementForCodePostal`), never hand-invented streets/postcodes.

- _(in progress)_

## What went well

- _(tbd)_

## What could've gone better

- _(tbd)_

## Open questions

- _(tbd)_

## Concrete next steps

- _(tbd)_

---

| metric | value |
| --- | --- |
| shift window | 02:58 UTC → (15:00 UTC) |
| models trained | 0 (so far) |
| Modal $ spent | $0 / $20 |
| NaN incidents | 0 |
| CI failures | 0 |
| demo/prod regressions shipped | 0 |
