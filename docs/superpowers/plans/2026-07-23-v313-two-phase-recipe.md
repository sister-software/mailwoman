# v3.13 — two-phase classifier-LR recipe (pre-registered proposal, OPERATOR-CONDITIONAL rather than LAUNCHED)

**Date:** 2026-07-23 (night #2) · **Status:** proposal

The stop rule ended the v3.12 lineage. This document writes out the dossier's **option B** so the
morning decision only needs approval. **No step here has run.**

## Why B, mechanistically (the cRT diagnostic)

The dossier's falsification chain left three surviving hypotheses. The same-night cRT diagnostic
(frozen encoder, classifier-only training) distinguished them without extra runs. The Pennsylvania
`INV[comma-drop]` break is **absent at cRT-2k/4k/6k and present at cRT-8k**, with the same failure
signature as the full fine-tune. That result shows two things. First, the break comes from
**classifier-head dynamics**. Second, it is an **accumulation** effect of a hot classifier LR over
long exposure, and it appears well after the ~2k resurrection window has done its work. v3.12's own
checkpoint ladder agrees: 5k–7k narrow to one violation, and 8k regresses.

Both findings point at the same change: **keep the hot classifier LR only for the window that needs
it, then anneal it to the base LR.** No run in this arc has tried that. Every run held the classifier
LR at 0.001 for all 8k steps.

## The run (one variable vs v3.12.0-comma-resilient)

Clone `v3.12.0-comma-robust.yaml` verbatim and make one change. The NZ allowlist stays. Punct-drop
0.6 also stays, because it did no harm and matching its share to the data is principled.

- **Phase 1 (steps 0–2000):** `classifier_learning_rate: 0.001`, the resurrection window, as
  before.
- **Phase 2 (steps 2000–8000):** The classifier LR is annealed to the base group's LR (1e-4). The
  restamp fix (62d73672/32b58ed4) already makes a resume pick up a config LR change. The run
  therefore uses `--resume auto` at step 2000 from its own phase-1 checkpoint, with the config
  edited to `classifier_learning_rate: 0.0001`. **Use resume, never init_from**, because the
  optimizer state carries the window's momentum (the resume-vs-init_from rule).
- Use the same seed, a fresh output dir `output-v3130-two-phase-s42`, save_every 1000, and 8k
  steps total.

Cost: about 25 min on an A100 (about $1.50), plus the standard grade.

## Pre-registered acceptance (inherited verbatim from v3.12 — no reinterpretation)

1. Primary: A gauntlet-clean checkpoint exists, and the invariance suite (`--baseline v385`) shows
   no new violation class at the selected checkpoint. **Check every checkpoint, including odd
   ones.**
2. GB dep-loc board with prior @ δ=5.0 ≥ 69/69 emit / ≥ 66 tag-correct, and FP 0 on gb-golden's
   own no-dependent_locality rows. The venue-confound floor stays a separately reported number.
3. Guards: digit ≥ 0.755, FR bare-locality ≥ 0.90, golden us/fr within ±0.7pp of 87.6/91.1,
   6 presets byte-identical, and no tag more than 2pp down in error analysis relative to v385.
4. Reads that are not bars: NZ raw-BIO and decode emission should stay at or above the v3.12
   level, which shows the allowlist fix still takes effect. Track the dep-loc raw-BIO trajectory
   across phase 2 to see whether the anneal keeps the resurrected tags or whether they are buried
   again at base LR. Either answer tests the window theory.
5. Stop rule: This proposal gets one run, meaning one phase-1 run plus one phase-2 resume. The
   phase boundary is part of the recipe rather than an iteration. If no checkpoint is clean, return
   to the redesign table with the accumulation hypothesis also falsified. Do not sweep anneal
   points or add a third phase.

## Open parameter the operator may want to move before launch

The phase boundary (2000) comes from the checkpoint sweep's measurement of the resurrection window
(~2k) and from cRT staying clean through 6k. If the operator prefers more margin, 3000 is
defensible, because cRT was still clean at 4k and 6k. The pre-registration above assumes 2000.
Pick one value before launch, because this registration does not allow sweeping the boundary.
