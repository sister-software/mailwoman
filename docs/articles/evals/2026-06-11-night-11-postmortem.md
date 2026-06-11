# Night-11 postmortem — 2026-06-11 (DRAFT, completed at shift end)

## What shipped

- **v4.4.0** — the boundary consolidation, end-to-end during the shift under granted ship-on-pass
  authority: gate PASS 17/17 (the densest pre-registered spec to date; the perturb arena gated
  for the first time), all backends byte-verified (HF default, R2 md5 `f086951a…`, npm 4.4.0
  registry-direct, docs-build green). po_box 0→89.1, cedex 0→96.1, intersections 0→100,
  perturb 64→72, FR region 16.2→25.6. #513 + #487 closed.
- **`neural/span-bridge.ts`** — a permanent decoder layer born from the gate's first FAIL:
  punctuation-gap span bridging (the corpus label format cannot express intra-span punctuation;
  dotted po_box leaders decoded as period-truncated fragments at 98%). Required ship config from
  v4.4.0 (`requires_bridge`). Two iterations: the comma over-merge its first re-gate caught is
  excluded by the separator rule. 8 tests.
- **Train-time conventions loss-mask** — implemented, Modal-verified (gradient-isolation test
  exact-zero via the NEW `run_tests` entrypoint), deliberately NOT ridden (unprobed) and its
  probe deliberately NOT spent (consult: confounded attribution, sub-3pt unreadable at +4k).
  Banked for the next full run with a pre-registered FR-region floor.
- **codex `fr/cedex` slice** (closes PR #516's documented gap; builder round-trips it loud),
  **DE leakage evidence** (0.7–1.3%, USPS-homograph mechanism — the future `de` row's evidence),
  **transition-masks design note** (slice 3 recorded with its failure mode, deliberately unbuilt),
  **gate watch lenses** (VT-intersection + glue rows, recorded-not-floored), **#517 filed**
  (Commonwealth/military po_box — the postal arena's last 0% class, now characterized).
- **Codex-review absorption**: reconcile-defaults docs corrected (status/api/STAGES), scorecard
  link + int8 size fixed, conventions glossary entry.
- **S4 calibration refresh**: the isotonic tables now describe the shipped model (they were
  three releases stale AND collected channel-bare). Collector upgraded to ship config; held-out
  ECE 0.0643 → 0.0034, OA-only 0.0113; per-locale tables beat global everywhere. Finding worth a
  flag: the consistent-label era model is UNDERconfident (mean conf 91.0 vs acc 97.45) — the
  miscalibration direction flipped from the v4.0.0 era.
- **S5 trend page**: `docs/articles/evals/score-trends.md` generated from the ledger (six
  versions × three locales; `build-score-trends.py` regenerates per ledger row). US locality
  7.8 → 75.7, postcode 0.1 → 98.3 — the project history in one table.
- **P2.5 DE holdout**: Saarland + Mecklenburg-Vorpommern added to `defaultHoldouts()` — takes
  effect at the next base rebuild (a holdout added after a corpus is built is
  leakage-laundering, not a holdout). 1500 corpus tests green.
- **P2.8 pipeline contract**: the decode-time constraint layers (conventions mask + span bridge)
  documented as the ship-config decode contract. The angle lint narrowed to its measured
  breakage class (digit prose) after false-positiving on legitimate JSX.

## What went well

- **The corrective loop**: FAIL → row-level characterization → deterministic decode-side fix →
  re-gate, twice in one night, both with regression tests, $0 GPU. The pre-registered gate did
  exactly its job: it caught a structural corpus-format limit (dotted spans) AND caught the
  first fix over-reaching (comma merges) before either could ship.
- **Probe-before-spend discipline paid out in both directions**: three data levers rode only
  after solo probes; the loss-mask probe was deferred because the consult showed the read would
  be uninterpretable — the $15 cap ended the night untouched.
- **The Modal `run_tests` entrypoint** closed a real gap (torch-dependent tests silently skipping
  locally) and immediately verified the loss-mask's gradient isolation.

## What could've gone better

- **I killed battery 1 by editing the runner mid-run** — the same hazard I had explicitly dodged
  hours earlier. Cost: the int8/arena legs of one battery (~20 min; the fp32 FAIL record
  survived). Rule, now standing: scripts with live instances are immutable; stage edits and
  apply between runs.
- **The shard agent's audit gate shared its builder's blind spot** (both normalized the dots
  away), so the dotted-truncation bug reached the full run instead of dying at the audit. Audit
  gates need at least one check that operates on the RAW surface, not the builder's own
  normalization.
- DeepSeek consults again mixed one keeper insight per session with fabricated specifics
  (the "glue rows tie rue→street_prefix" mechanism never existed). The verify-before-steering
  rule held; no damage.

## Decisions made autonomously

1. **Shipped v4.4.0** on the 17/17 PASS — explicitly granted at kickoff (decision point 1).
2. **Built the span bridge as the po_box corrective** instead of a data lever — the row audit
   showed a structural format limit (10× exposure moved the number +2.9), making decode-side
   containment the only same-night option. Alternative (char-offset corpus labels) is recorded
   in the gate doc as the structural cure.
3. **Excluded commas from bridgeable gaps** after the second FAIL — alternative was tag-scoped
   bridging (only po_box/cedex), rejected as a special case that would hide the same bug for the
   next dotted tag.
4. **Deferred the conventions loss-mask probe** on consult advice — the FR-region recovery was
   already attributable to the data levers; an uninterpretable probe wastes a cap slot.
5. **Did not implement transition masks** (stretch S1) — no live failing class after the bridge;
   recorded the design + failure mode instead.

## Open questions for the operator

- The blog draft (decision point 3): a v4.4.0 wrap exists as an option; nothing written yet —
  morning call.
- #517 (Commonwealth/military po_box): needs codex au/nz slices first — queue position?
- The char-offset label format (the structural cure for what the bridge contains): a corpus-
  format change with wide blast radius — deserves a day-session design, not a night slot.
- FR house_number 97.7→97.2 and fr.postcode 99.7→99.6: both within single-row noise, both
  recorded in the card's known-regressions — flagging per the no-silent-drift habit.

## Concrete next steps

- Conventions loss-mask rides the next full run (`use_conventions_loss_mask: true` + a
  pre-registered FR-region floor ≥ 25.6).
- #517: codex au/nz po_box slices → shard vocabulary extension → next consolidation.
- S6 drafted here: the next gate spec (v4.5.0-class) promotes the two watch lenses to floors
  with one release of history behind them — proposed bars: VT-intersection golden a/b ≥ 90
  (v4.4.0 measured 94.9/96.1) and glue-rows region/postcode recall ≥ 85 (measured 93/97).
  Stated-change comment required in the spec per the no-drift contract.

## Numbers

| Metric | Value |
| --- | --- |
| Shift window | 03:30–15:00 UTC (planned) |
| Models trained | 0 (the v1.3.0 run pre-dated the shift; gate + ship only) |
| GPU spend vs cap | **$0 / $15** |
| Gate batteries run | 3 (FAIL → FAIL → PASS, all on one artifact) |
| Releases shipped | 1 (v4.4.0, all backends verified) |
| Issues closed / filed | 2 closed (#513, #487) / 1 filed (#517) |
| NaN incidents | 0 |
| CI failures | 0 (one self-inflicted battery abort, see above) |
| Demo regressions | none known (operator browser-verify stands) |
