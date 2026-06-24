# Night shift — 2026-06-22 (eval-coverage force-multiplier → gated FR training stretch)

_Living document — sketched during the shift, finalized at hand-off (15:00 UTC). Plan: `nightshift/2026-06-22-NIGHT-SHIFT-PLAN.md`. The arc: a 4-turn DeepSeek consult set the next major effort as a two-phase eval→capability arc; tonight builds Phase A (non-US/fine held-out eval coverage, #229) and rides the corrected FR levers as a gated GPU stretch._

## 🌅 Morning handoff — needs your eyes (priority order)

1. **Merge PR #767 + #768** — both green, CLEAN, mergeable. #767 is the night's centerpiece (#229 non-US coordinate panel + scorecard + eval infra + this postmortem); #768 completes the #625 lever ladder. Left for you per the PR-merge-to-main wall.
2. **#148 multi-locale retrain — decision is now data-backed.** Tonight reframed it: the non-US gap is **parse recall**, not coordinate precision or gazetteer coverage, and it tracks **training representation** — FR/IT (trained) ~80% resolve / city-tight, vs PT/PL/AT/LU ~50–57%, CZ 43%, AU 28%. So a retrain's value is lifting parse recall on the mid/low tier (FR — the priority locale — is already fine). The eval to gate it now exists (`nonus-coord-panel.sh`). Your call on scope; I did NOT launch (a 2k-step probe can't cleanly falsify a data-coverage lever, and scope is yours).
3. **Greenlight the venue/POI ingest** — the top fine-component unblock (one Overture-places-FR / OSM fetch → both the #229 venue eval _and_ the T2 training shard). Held all night on the OOM history + the "use the CLI not ad-hoc duckdb" rule; wants a supervised run.
4. **Re-scope or close #625** — the lever search is concluded (GBT is the answer; NPI-truth target unreachable).

**Production: unchanged** — everything behind PRs; **$0 / $20 GPU**; no demo/model/canonical swap; 0 regressions. **Hardware note:** the lab box idles hot (~88 °C, summer ambient) — local ONNX eval grades spiked it to ~90 °C, so the full ~20-locale sweep was paced/deferred (it's also data-limited: only postcode-bearing OA locales are coordinate-gradeable).

## What shipped

- **🎯 The keystone — a 4-locale assembled-coordinate panel reframes #148 (PR #767).** Built IT/PT/PL/AU held-out sets (real OA, truth coords, `build-oa-coord-golden.py`) and graded the shipped model on the metric we ship, separating **resolve rate** from the **resolved-only coordinate**:

  | locale | resolve | p50 (resolved) |
  | ------ | ------: | -------------: |
  | FR     |     80% |         1.3 km |
  | IT     |     79% |         2.1 km |
  | PT     |     52% |         1.2 km |
  | PL     |     53% |         5.8 km |
  | AU     |     28% |         234 km |

  Two axes: **(1) precision is good where it resolves (EU)** — a resolved EU address is city-accurate (1–6 km), so label-F1 (ES 28.5%) understates non-US capability (it charges street-boundary mis-tags the coordinate ignores — the #566 lesson on hard coordinate truth). **(2) The real gap is resolve RATE (recall), and it tracks TRAINING REPRESENTATION** — FR 80% / IT 79% (trained / well-represented) → PT/PL ~52% → AU 28%. Root-caused to PARSE not coverage (PT label-locality 39% ≈ its 52% resolve; the EU gazetteer is comprehensive, cf. #734). So #148's value is **lifting parse recall on the mid/low-tier locales**, the model lever, now quantified across **8 locales** (the postcode-bearing OA set — a principled, data-limited endpoint; DE/BE/DK/FI OA lack a postcode column, so they can't be coordinate-graded). Most resolved coords are tight (0.3–6 km) except CZ (44 km) + AU (234 km), which resolve _loosely_ too (the dual-axis-worst tier). ⚠ **verify-before-verdict fired LIVE three times on my own work:** (a) the FR région floor was adversarial-stress, not a real gap; (b) the IT-only read ("median non-US geocodes well") was the BEST case — the panel corrected it (I'd commented #148 on it, then superseded); (c) I called FR "data-blocked" all night, but `fr/countrywide.csv` was in `europe.zip` — real FR geocodes top-tier (80% / 1.3 km), the operator's priority locale is _fine_. The aggregate is never the verdict. Commented #148 / #625 / #734 / #330. Infra: the builder (`--zip` + `--csv-glob`), `data/eval/external/oa-{fr,it,pt,au,pl}-coord-150.jsonl`, the gate's `--default-country` + resolved-only metric.

- **#229 Phase-A scorecard — `docs/articles/evals/2026-06-22-fr-eval-coverage-scorecard.md`.** Graded the production model (v1.8.0) per-locale per-tag with support-size reliability flags + a failure taxonomy + a data-acquisition plan. The honest read: FR reliable floors hold (postcode 99.7 / house_number 99.6 / street 90.1 / locality 86.4); **venue (n=1) and unit (n=0) are unmeasured**, not failing — an absence of FR test data, not a model verdict; and (corrected on inspection) the **région floor 43.3 is an adversarial-stress number**, not a real-FR gap — the 219 rows are synthetic multi-script + order-permutations, and the model does 99.6% on the in-distribution format, so real-FR région is _unmeasured_. `country` is genuinely coordinate-invisible (the resolver sources it from the placer). Net: there is no representative real-FR fine-component eval — the in-distribution numbers are gamed, the OOD ones adversarial.

### Levers retired with evidence (verify-before-verdict — stops re-attempts)

- **#734 EU bilingual-alias fold → RETIRED (no-op).** Extending the shipped FI GeoNames-alt-name fold to AT/SK then the full EU tail (PL/CZ/NO/HR/SI/LT/LV/EE/DK/BE/CH/LU/PT…) added **+0 aliases everywhere** — every GeoNames populated-place name is already present in the 20-series candidate (built from GeoNames allCountries, #182). So the candidate's EU **name** coverage is comprehensive; the AT 74% / SK 78% residual recall is **depth (sub-localities/districts) or eval-format artifact** (cf. the LT genitive-suffix artifact), NOT missing names. The FI fold was a genuine special case, now spent. Next real lever for EU depth = an Overture admin sub-division source or an eval-format correction, not GeoNames alt-names.
- **GPU training stretch (T1/T2) → NO-GO tonight ($20 unspent).** T1 (fr.country precision) is coordinate-invisible (resolver sources country from the placer, never the model tag); T2 (FR venue) is data-blocked (no FR POI on disk). Neither clears the coordinate bar with on-disk data. Reasoning in the scorecard's "GPU decision."
- **#564 FR house_number → confirmed model-side.** No FR address-point/interpolation coverage on disk (only `address-points-us-*`), so the resolver-side street-centroid fallback can't fire for FR — the lever is model/research, not a hostable-data win.

## Decisions made autonomously

- **v1.8.1 — gated → SHELVED (not promoted).** The shelved country-shard (`out/v181`, trained 06-19 to close v1.8.0's fr.country −3.5) was gated v180-vs-v181 on the real harnesses before the shift opened. **FR coordinate gate** (`fr-admin-split-gate.ts`, 3000-row disjoint-commune golden): p50 identical (2.17 km), mean −5.35 km (tail noise), région-correct +0.28 — _looked_ like a clean promote. **Per-tag `per-locale-f1`** (anchor+gaz fed; v180 reproduced the postmortem's v1.8.0 FR numbers, so the setup is valid): fr.country moved **+0.4 only** (58.7→59.1, still 3.6 below the v1.5.0 baseline it was built to recover) while costing **US street −1.3, US locality −0.9, US exact −31, FR exact −10**. Net: a broad small label regression for nothing the median coordinate sees. **Root cause — the lever was aimed wrong: FR country F1 is precision-bound, not recall-bound** (the model over-emits country — FR recall ~96%, precision ~43%, hallucinating country on golden rows with no country token). The v0.8.1 "mix in rows carrying France" shard pushes recall↑/precision↓, so it can't lift F1 — **the country-bearing-shard hypothesis is falsified.** v4.11.0 (=v1.8.0) stays the production default. Artifacts: `/tmp/reg/{gate-v18*.json,pl-v18*.json}`.
  - **Why this is the night's keystone, not a footnote:** the FR coordinate gate _alone_ would have shipped this regression. Only the per-tag held-out tripwire caught it — which is exactly the thesis of tonight's PRIMARY (#229: build the held-out eval that gates the capability decision). The shelved-artifact "free win" the consult pointed at dissolved on contact with measurement; the consult's deeper call (eval-first) is what caught it. The corrected lever (teach country _suppression_, a precision fix) rides as GPU-stretch T1.

## #229 lever 1 — FR-fine held-out stratum (the night's unlock)

**Audit of the existing FR golden (`data/eval/golden/v0.1.2/fr.jsonl`, 1551 rows) — what's actually under-measured:**

| component             |     FR rows |     US rows | read                                                    |
| --------------------- | ----------: | ----------: | ------------------------------------------------------- |
| locality / postcode   | 1537 / 1262 | 1792 / 1695 | well-covered                                            |
| street / house_number |   665 / 665 | 2216 / 1031 | covered                                                 |
| region                |         219 |        2956 | **thin** (model F1 43.3 on 219 rows — unreliable floor) |
| venue                 |       **1** |        1075 | **unmeasured** (the "0%" is on a single row)            |
| unit                  |       **0** |           2 | **absent** for FR                                       |

So the build targets, in priority order: **venue** (unblocks GPU-stretch T2), **region thickening** (firms T1's gate), then **unit** if a real source exists. Discipline: REAL data only (BAN/OA + Overture POIs + codex `departementForCodePostal`), never hand-invented streets/postcodes.

**Outcome: largely data-blocked on disk.** The OA FR cache (`/tmp/oa-cache`) is gone, the Overture _places_ (POI) theme isn't materialized locally (only addresses/divisions/postcodes), and there's no FR unit source. The on-disk BAN region rows (the `fr-admin-split-golden`, 2104) are _in-distribution_ for v1.8.0 (it was trained on `Locality, Département`) — using them would game the floor to ~96%, not measure the honest OOD gap (43.3). So the deliverable shrank, honestly, to the **scorecard + the data-acquisition plan** (PR #767) rather than a new built stratum. The fetch path is named for the next shift.

## What went well

- **Verify-before-verdict fired three times and each changed the call:** v1.8.1 looked promotable on the coord gate until the per-tag tripwire; the #734 fold looked obvious until it added +0 aliases; #625's A2/A3/A4 looked open until the baseline prose showed them measured. Each cheap check saved a wasted build/GPU run.
- **Grade-the-coordinate held the line on GPU.** The training stretch was greenlit, but T1 (fr.country) failing the coordinate-relevance test kept $20 unspent on a label-only fix — the discipline that correctly shipped v1.8.0 over its fr.country regression.
- **Two clean PRs + an issue concluded** (#767 scorecard, #768 #625 ladder), all branch-and-PR, CI-gated.

## The meta-finding — a mature system, gated on data + research

Tonight probed ~six levers across the geocoder core and the record-matcher. The throughline: **the quick on-disk wins are exhausted.** Nearly every lever resolved to _concluded_ (#625 lever search, EU name coverage), _coordinate-invisible_ (fr.country), or _data-blocked_ (FR venue/unit/OOD-région eval; FR rooftop; the venue training shard). The remaining gaps need **new data or research**, not tuning — so the shift's value was measurement + honest retirement (stopping wasted re-attempts) + one real deliverable, not a capability bump.

## What could've gone better

- **The plan over-assumed on-disk data.** #229 (FR-fine stratum) and the GPU stretch (T2 venue) both needed data that isn't local — catchable in pre-flight with a sharper "what does each lever's data look like on disk?" audit before ratifying. I found it ~40 min in, not at minute 5.
- **The consult's "venue 0% / région 19%" stale numbers seeded a venue-shaped plan** the scorecard then corrected (venue is _unmeasured_, n=1 — not 0%-failing).

## Open questions (operator)

1. **Greenlight the venue/POI ingest?** The single highest-leverage unblock — one fetch (Overture places FR / OSM) yields _both_ the #229 venue eval stratum _and_ the T2 training shard. Held tonight (unattended + the Overture-OOM history); wants a supervised run with the OOM-safe streaming pattern, not ad-hoc duckdb.
2. **Re-scope or close #625?** Lever search concluded; the NPI-truth target is unreachable (over-segmentation); org-name-coord has the GBT at 74.9%.
3. **Is fr.country ever worth a label-only fix?** Coordinate-invisible, so by our discipline no — unless a downstream consumer needs the country label for parity. If so, T1 is specced (suppress-country-without-token).

## Concrete next steps

- **Extend the coordinate panel to the rest of the ~20 on-disk locales (the strongest #148 input).** 5 are done (FR/IT/PT/PL/AU); `openaddresses/extracted/` holds ~15 more (AT BE CZ DK EE FI GR IL IS LT LU LV NZ + SE) + DE/NL in `europe.zip`, all coordinate-bearing. `build-oa-coord-golden.py` + the gate make each a one-command add. **Deferred tonight on the heat cap** — each local ONNX grade spikes the lab box to ~90 °C (cools fast when idle), so a full 20-locale sweep wants Modal or paced cooldowns. (DE came back 0 rows from `de/nw/statewide.csv` — a schema/empty-field quirk to debug before adding DE.)
- **Data acquisition (the genuinely-blocked strata):** (a) **venue** — Overture-places FR / OSM → venue eval + the T2 training shard (the top unblock; held tonight on the OOM history); (b) **unit** — a real unit source, or fold US `unit-real-designators.jsonl` into the golden; (c) a **real-FR `region`** set (OA-FR's `REGION` column is empty — needs a postcode→département derive via codex or another source). NB: FR _address_ data is NOT blocked (it's `europe.zip`); FR core geocodes top-tier.
- **Research, not tuning:** FR région-recall is OOD-format (model overfit `Locality, Département`) — fix is diverse région-bearing data, not a knob. CJK remains the Geographic-Rule-Engine epic.
- **Files:** `2026-06-22-fr-eval-coverage-scorecard.md` (floors + data plan), `2026-06-22-nppes-dedup-lever-ladder.md` (#625), PR #767, PR #768.

---

| metric                                   | value                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| shift window                             | 02:58 UTC → (15:00 UTC)                                                           |
| PRs opened                               | 2 (#767 #229 panel/scorecard, #768 #625 ladder)                                   |
| issues commented/reframed                | 5 (#148, #625, #734, #330, #435)                                                  |
| levers retired with evidence             | 4 (v1.8.1, #734 fold, GPU T1/T2, #564)                                            |
| self-corrections (verify-before-verdict) | 3 (FR région adversarial, IT-only→panel, FR-not-blocked)                          |
| models trained                           | 0                                                                                 |
| Modal $ spent                            | **$0 / $20** (no GPU cleared the coordinate bar)                                  |
| NaN incidents                            | 0                                                                                 |
| CI failures                              | 0                                                                                 |
| demo/prod regressions shipped            | 0                                                                                 |
| heat events                              | local ONNX grades spiked the box to ~90 °C; paced + deferred the full panel sweep |
