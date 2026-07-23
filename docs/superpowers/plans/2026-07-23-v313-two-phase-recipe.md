# v3.13 — two-phase classifier-LR recipe (pre-registered proposal, OPERATOR-GATED, NOT LAUNCHED)

**Date:** 2026-07-23 (night #2) · **Status:** proposal — the stop rule ended the v3.12 lineage;
this is the dossier's **option B** written out so the morning decision is a green-light, not a
drafting session. **Nothing here has run.**

## Why B, mechanistically (the cRT diagnostic)

The dossier's falsification chain left three surviving hypotheses; the same-night cRT diagnostic
(frozen encoder, classifier-only training) discriminated them for free: the Pennsylvania
`INV[comma-drop]` break is **absent at cRT-2k/4k/6k and present at cRT-8k** — identical failure
signature to the full fine-tune. So the break (a) lives in **classifier-head dynamics**, and (b)
is an **accumulation** effect: hot classifier LR × long exposure, emerging well after the ~2k
resurrection window has done its work. v3.12's own ladder agrees (5k–7k narrow to one violation;
8k regresses).

Both facts point at the same lever: **keep the hot classifier LR only for the window that needs
it, then anneal to base** — never yet tried in this arc (every run held classifier LR at 0.001
for all 8k steps).

## The run (ONE variable vs v3.12.0-comma-robust)

Clone `v3.12.0-comma-robust.yaml` verbatim (NZ allowlist stays; punct-drop 0.6 stays — it did no
harm and the matched share is principled) + the single change:

- **Phase 1 (steps 0–2000):** `classifier_learning_rate: 0.001` (the resurrection window, as
  before).
- **Phase 2 (steps 2000–8000):** classifier LR annealed to the base group's LR (1e-4). Mechanism:
  the restamp fix (62d73672/32b58ed4) already makes a resume pick up a config LR change — so the
  run is `--resume auto` at step 2000 from its own phase-1 checkpoint with the config edited to
  `classifier_learning_rate: 0.0001`. **Resume, never init_from** (optimizer state carries the
  window's kinematics — the resume-vs-init_from rule).
- Same seed, fresh output dir `output-v3130-two-phase-s42`, save_every 1000, 8k total.

Cost: ~~25 min A100 (~~$1.50) + the standard grade.

## Pre-registered acceptance (inherited verbatim from v3.12 — no reinterpretation)

1. PRIMARY: a gauntlet-clean checkpoint exists; invariance suite (`--baseline v385`) shows NO new
   violation class at the selected checkpoint; **checked at every checkpoint, odd included**.
2. GB dep-loc board with prior @ δ=5.0 ≥ 69/69 emit / ≥ 66 tag-correct; FP 0 on gb-golden's own
   no-dependent_locality rows (the venue-confound floor stays a separately-reported number).
3. Guards: digit ≥ 0.755; FR bare-locality ≥ 0.90; golden us/fr within ±0.7pp of 87.6/91.1;
   6 presets byte-identical; error-analysis no tag > 2pp down vs v385.
4. Reads (not bars): NZ raw-BIO + decode emission ≥ the v3.12 level (the allowlist fix keeps
   flowing); dep-loc raw-BIO trajectory across phase 2 (does the anneal hold the resurrection, or
   does re-burial resume at base LR? — either answer is information the window theory needs).
5. STOP RULE: one run (= one phase-1 + one phase-2 resume; the phase boundary is part of the
   recipe, not an iteration). No checkpoint clean ⇒ back to the redesign table with the
   accumulation hypothesis falsified too — no anneal-point sweeps, no third phase.

## Open parameter the operator may want to move before launch

The phase boundary (2000) is taken from the checkpoint-sweep's resurrection-window measurement
(~2k) and cRT's clean-through-6k read. If the operator prefers more margin, 3000 is defensible
(cRT was still clean at 4k and 6k); the pre-registration above assumes 2000. Pick ONE before
launch — the boundary is not sweepable inside this registration.
