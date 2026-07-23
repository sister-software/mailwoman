# dependent_locality redesign dossier — morning read, 2026-07-23

**Status:** stop rule executed TWICE (v3.11.x lineage closed; v3.12.0 no clean checkpoint). No knob
iteration permitted. This doc is the evidence file + option space for the redesign discussion — it
recommends, it does not decide. Sources: `.superpowers/sdd/progress.md`,
`.superpowers/sdd/task-8-report.md` (§ "v3.12.0 ship grade"),
`docs/superpowers/plans/2026-07-23-v312-comma-robust-recipe.md`,
`corpus-python/src/mailwoman_train/configs/v3.12.0-comma-robust.yaml` (on branch
`feat/v312-comma-robust`, checked out), `docs/articles/evals/2026-07-22-night-en-gb-postmortem.md`,
`docs/articles/evals/2026-07-23-placetype-pair-scorecard.md`.

**The one fact that closed everything:** `INV[comma-drop]` on
`"1600 Pennsylvania Ave NW, Washington, DC 20500"` — the comma-free form loses rooftop resolution
(38.8977,−77.0365 → 0,0). NEW vs the v385 profile (v385 holds this exact case, same session, same
board). Present at **every checkpoint of every dep-loc-recipe run**: feed-2k/8k, consolidate-10k,
and all 8 v3.12 checkpoints.

## 1. The falsification chain

| #   | Hypothesis                                                                                                         | Test (run / checkpoints)                                                                                                                                                                    | Receipt                                                                                                                                                                                                                                  | Verdict                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Starvation** — tag dead because too few positive rows reach the fresh head                                       | probe-1 (2k, synth-gb w6.0 ≈ 1.3% dep-loc stream) → probe-2 (ONE var: w36.0 ≈ 6.6%)                                                                                                         | probe-1: decode 0/246 NZ + 0/69 GB, raw-BIO 2/69 gap 4.61. probe-2: decode **3/246 + 1/69 — first emissions ever**, raw-BIO 12/69 min-gap 0.000                                                                                          | **CONFIRMED as confound, then SUPERSEDED** — feed run (8k, 4-locale at matched 6.66% density) went back to 0/246 + 0/69 both layers. Density alone doesn't hold the tag |
| 2   | **Encoder drift** — re-burial caused by the encoder moving under the head                                          | cRT probe `v3.12.0-crt-probe` (frozen encoder, 12,705 trainable params, ~5 min GPU), 1k–8k                                                                                                  | Reproduces the re-burial curve with the encoder frozen: GB raw-BIO 3/69→1→0→4, gap erosion 4.591→4.867; decode 0 throughout; digit board tracks feed within 1pp at every checkpoint (0.895/0.848/0.795/0.870 vs 0.890/0.853/0.782/0.868) | **FALSIFIED** — re-burial is a **classifier equilibrium**, not representation drift. Side-finding: digit-board sensitivity lives substantially in the classifier layer  |
| 3   | **Late-save / data-order anomaly** — the 7850–7950 train-loss bump immediately before the 8k save caused the break | `v3.11.1-deploc-consolidate`: resume feed-8k +2k at damped classifier LR                                                                                                                    | Comma-drop break **byte-identical 8k ≡ 10k**; every other guard PASSes at 10k (golden-us at 0.06pp margin)                                                                                                                               | **FALSIFIED** — stable learned behavior, not churn. Stop rule #1 executed; v3.11.x closed                                                                               |
| 4   | **Comma-share** — dep-loc shards ~100% comma-structured promoted commas to load-bearing boundary evidence          | `v3.12.0-comma-robust`: Step-0-verified Fix B, `augment_punct_drop_prob` 0.3→0.6 (comma-free share 0.377, matched to base corpus; shards measured 23.8–25.0%), 8k, all 8 checkpoints graded | Pennsylvania break NEW at **all 8** checkpoints (invariance suite + gauntlet agree); invariance-NEW 5–9 per checkpoint; gauntlet 3→3→3→3→**1**(5k)→**1**(6k)→**1**(7k)→3(8k, + new `BAND[transpose]` 1295.2km)                           | **FALSIFIED** — the one pre-registered variable, aimed at exactly this failure class, moved nothing on it in 8k steps                                                   |

Four mechanisms measured and closed. Full transcripts:
`scratchpad/gb-probe-grade/{invariance,gauntlet}-cr-00[1-8]000.txt`; grades in
`task-8-report.md` (§ Checkpoint sweep, § cRT probe curve, § v3.12.0 ship grade).

## 2. What we know is TRUE

- **Resurrection works.** Probe-2 produced the first production dep-loc emissions ever (decode NZ
  3/246 + GB 1/69, all tag-correct; raw-BIO GB 12/69 min-gap 0.000). The tag is learnable — the
  null condition was never met.
- **It's a ~2k window.** Feed checkpoint sweep: GB raw-BIO any-fire peaks 5/69 @ step-2000, then
  0/69 at 4k/6k/8k; gap means worsen monotonically 2k→8k (GB 4.512→4.942, NZ 6.068→6.629). The
  93% negative mass re-buries the tag at hot-LR speed after ~2k steps.
- **The pair prior converts marginal emission mass into full recall.** Three-way ablation
  (`2026-07-23-placetype-pair-scorecard.md`): v385+prior@δ6 = 3/69; feed+prior-OFF = 0/69;
  feed+prior-ON@δ\* = **69/69 emit, 67/69 tag-correct (97.1%)**. Each ingredient provably
  necessary; the fine-tune puts the tag within δ, the prior supplies the calibrated push.
- **The NZ allowlist fix works.** v3.12 produced the first NZ decode emissions ever (peak 5/246 @
  6k, 100% tag-correct where fired; raw-BIO 15/246 @ 6k — more than the entire v3.11.x lineage's
  7 graded checkpoints combined, which totaled 4 firings). Resurrection generalizes across
  locales once the shard actually flows (`country_weights NZ: 1.0`; the v3.11.x "4-locale" mass
  was silently 3).
- **The break narrows to ONE stubborn class late-run.** v3.12 steps 5k–7k hold gauntlet at exactly
  1 violation — Pennsylvania comma-drop only; the NY-cell trio (num-ordinal/abbrev, the 350-Fifth-Ave
  283.5km class) heals at 5k and stays healed through 7k. 8k regresses (3 violations + the new
  1295km transpose). Best invariance-NEW count is also 7k (5). Something late-run partially
  self-heals everything except Pennsylvania.

## 3. The surviving hypothesis space

Why does the Pennsylvania comma-drop break appear in ALL dep-loc-recipe runs and never in v385?
Remaining candidate common factors — every run shared all four of: hot classifier LR (1e-3, 10×
base), reinit of rows 7/8, ~3.2M dep-loc shard rows, init_from v385.

**(a) The hot classifier LR itself reshapes US-tag decision boundaries.** The cRT side-finding is
the tell: the digit board moved under classifier-ONLY training, within 1pp of the full-feed curve —
classifier-layer updates alone demonstrably move US-shaped behavior.
_Cheapest probe (zero-GPU, ~hours):_ run gauntlet + invariance on the **cRT checkpoints** — they
are already exported and local (`task-8-report.md` § cRT probe curve) and were never graded on
these suites. cRT has the hot LR + reinit but a frozen encoder: if the Pennsylvania break appears
there, the break lives entirely in the classifier head (confirms a/b, kills any encoder-side story);
if absent, the break needs encoder participation (points at c).
_GPU probe if needed (≤2k, ~$0.50):_ feed recipe at classifier LR = base 1e-4, reinit kept. Break
absent → LR is causal. (Dep-loc won't resurrect at base LR — that's fine, this is a diagnosis run.)

**(b) Reinit of rows 7/8 perturbs the shared classifier trunk equilibrium.** Rows 7/8 are re-drawn
from mean-of-live; the softmax is competitive, so two reshaped rows change every other tag's
decision margins at initialization.
_Cheapest probe (≤2k, ~$0.50):_ feed recipe, hot LR, **no reinit** (rows kept from v385). Break
present without reinit → kills (b) as necessary; break absent → reinit is load-bearing for the
damage. Zero-GPU complement: cosine/margin analysis of the non-dep-loc classifier rows feed-8k vs
v385 (the row-7/8 cosine instrument from the run-A adjudication, pointed at the OTHER rows) —
large drift in `locality`/`postcode` rows would implicate the trunk perturbation directly.

**(c) The 3.2M-row dep-loc mass shifts boundary-evidence statistics in a way punct-drop can't
counter.** The aug drops commas, but the shard rows' comma-conditional structure may differ from
base in another correlated dimension — token order (dep-loc between street and locality), admin-token
density per row, P(field-boundary | comma) vs P(boundary | whitespace). v3.12 proved "match the
comma-free share" is not sufficient; the confound would be a second-order statistic.
_Cheapest probes (zero-GPU):_ (1) **Pennsylvania logit-trace diff** — per-token argmax + gap dumps
(the `TRACE_PRIOR_KINDS` / emission-dump plumbing in `neural/trace.ts`, plus the raw-BIO primitives
in `scratchpad/gb-probe-grade/`) on the comma'd and comma-free forms across v385 / feed-8k /
v3.12-7k: WHICH token flips to WHAT tag when the commas leave? That names the mechanism regardless
of hypothesis. (2) Corpus-stat diff: boundary-evidence statistics (comma-conditional transition
counts, admin density, field order) of the four shards vs the base stream. (3) Eval-time ablation:
the conditional-bias machinery (`conditional-bias-rescue.mjs`) inverted — bias AGAINST rows 7/8 on
the Pennsylvania input and see what resolution returns; tells you whether the break is dep-loc-row
interference or a broader boundary shift.
_GPU probe:_ shard mass at ¼ weight, 2k — break vanishes → mass is causal.

**(d) Interaction.** Only addressable after (a)–(c) reads; the probe matrix above is designed so
each run/analysis isolates one factor.

Zero-GPU order: cRT gauntlet grade → Pennsylvania trace diff → corpus stats / row-drift cosines.
The first two alone likely split the space before any GPU spend.

## 4. The option space (recommendation inputs, not a decision)

**(A) Diagnose-first micro-arc.** The zero-GPU probes above, then ONE targeted run chosen by their
verdict, under a new pre-registration. Highest information per dollar; respects the stop rule's
spirit (redesign from mechanism, not another knob). Risk: one more elapsed day before any model
ships — which option D absorbs.

**(B) Two-phase schedule.** Resurrect hot for 0–2k, then anneal `classifier_learning_rate` to base
for 2k–8k. Never yet tried — it was the original fork option A from night #1, and it is now a
one-command launch: the resume-LR clobber (`optim.load_state_dict` silently restoring checkpoint
LRs while the drift-audit printed the new values) was found and fixed (`62d73672` + `32b58ed4`,
reviewed). Mechanistically aimed at the confirmed ~2k window; the 5k–7k narrowing to a single
violation suggests the run partially self-heals late even at hot LR — an annealed tail should heal
harder. Risk: if hypothesis (b) or (c) is the cause, the break bakes in during the hot phase and
annealing won't remove it — which is exactly what the (a)-probes in option A would tell us first.
A and B compose: A's zero-GPU day, then B as the one targeted run if the trace evidence points at
the LR/schedule.

**(C) Accept-and-gate.** Ship a 7k-class checkpoint with the single Pennsylvania violation
adjudicated as acceptable. **NOT recommended:** the gauntlet metamorphic bar is a pre-registered
hard gate that has now survived two stop-rule executions; waiving it post-hoc for a US-invariance
regression on the most famous address in the eval set would be gate drift of precisely the kind the
pre-registrations exist to prevent — and a NEW violation class vs v385 is a shipped-user regression,
not a missing feature.

**(D) Locality-mapped v1 for the October talk.** en-GB ships on v385 — which is ALREADY the shipped
state: the merged arc code (prior inert-but-ready, `neural-weights-en-gb` shipping no model of its
own, cards keeping v385 identity) was designed for exactly this posture, and the night pivot's code
release (5 production bug fixes + en-gb package) is in flight. Zero model risk, zero GPU. The
dep-loc distinction waits for the redesign. **D is not exclusive with A/B** — D de-risks October
now while A→B runs at its own pace; the talk story (resurrection window, pair prior, gauntlet
catch) is already fully receipted whether or not a new model lands first.

## 5. Costs

| Option                               | Agent-nights | Modal $ | Notes                                                                                         |
| ------------------------------------ | -----------: | ------: | --------------------------------------------------------------------------------------------- |
| A (zero-GPU probes + 1 targeted run) |          1–2 |   ~$2–4 | probes $0 (checkpoints local); one 2k probe ~$0.50; one 8k candidate ~$1.50 + export/quantize |
| B (two-phase schedule, one run)      |            1 |     ~$2 | 8k ≈ 25 min A100 ~$1.50 + export/quantize/grading; launch-ready today                         |
| C (accept-and-gate 7k)               |          0.5 |      $0 | grading/battery only — but see NOT recommended                                                |
| D (v385 locality-mapped v1)          |           ~0 |      $0 | already the shipped state; code release in flight                                             |

A+B combined (the likely path if the operator wants a model this week): ~2 agent-nights, ≤$5.
Every prior full run in this arc cost ~$1.50 GPU; money is not the constraint — attributable
information is.

## Postscript (added during night #2): the cRT comma-drop diagnostic — hypothesis (c) substantially weakened

The headline zero-GPU probe proposed above was run the same night (already-local cRT checkpoints;
grading agent, ~2 min). Result: with the **encoder frozen for the entire run**, the Pennsylvania
`INV[comma-drop]` break is **absent at cRT-2k/4k/6k and present at cRT-8k** — the identical
failure signature (coordinate → 0,0) as the full-fine-tune lineage's own step-8000, confirmed
independently by the invariance suite and the gauntlet.

Reading: the break originates in **classifier-head dynamics under the dep-loc-heavy stream**, not
in encoder boundary statistics — hypothesis (c) is substantially weakened, (a)/(b) strengthen.
The late emergence (clean through 6k, breaks by 8k, matching v3.12's 5k–7k
single-violation narrowing followed by the 8k regression) is an accumulation shape: hot
classifier LR × long exposure degrades the head after the resurrection window has already done
its work. That is precisely the failure mode **option B** (two-phase schedule: hot through the
~2k window, anneal to base LR after) is built to avoid — B is now the mechanistically favored
run, with A's remaining probes (Pennsylvania logit-trace diff) as optional sharpening rather
than prerequisites.

Receipts: `.superpowers/sdd/task-8-report.md` § "cRT comma-drop diagnostic".
