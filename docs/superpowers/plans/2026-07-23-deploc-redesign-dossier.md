# dependent_locality redesign dossier — morning read, 2026-07-23

**Status:** The stop rule has been executed twice. The v3.11.x lineage is closed, and v3.12.0 produced
no clean checkpoint. No knob iteration is permitted. This doc collects the evidence and the option
space for the redesign discussion. It makes recommendations and leaves the decision to the operator.
Sources: `.superpowers/sdd/progress.md`,
`.superpowers/sdd/task-8-report.md` (§ "v3.12.0 ship grade"),
`docs/superpowers/plans/2026-07-23-v312-comma-robust-recipe.md`,
`corpus-python/src/mailwoman_train/configs/v3.12.0-comma-robust.yaml` (on branch
`feat/v312-comma-robust`, checked out), `docs/articles/evals/2026-07-22-night-en-gb-postmortem.md`,
`docs/articles/evals/2026-07-23-placetype-pair-scorecard.md`.

**The failure that closed both lineages:** `INV[comma-drop]` on
`"1600 Pennsylvania Ave NW, Washington, DC 20500"`. The comma-free form loses rooftop resolution
(38.8977,−77.0365 → 0,0). This violation is new relative to the v385 profile, because v385 passes
this exact case in the same session on the same board. It appears at **every checkpoint of every
dep-loc-recipe run**: feed-2k/8k, consolidate-10k, and all 8 v3.12 checkpoints.

## 1. The falsification chain

| #   | Hypothesis                                                                                                         | Test (run / checkpoints)                                                                                                                                                                      | Receipt                                                                                                                                                                                                                                  | Verdict                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Starvation** — tag dead because too few positive rows reach the fresh head                                       | probe-1 (2k, synth-gb w6.0 ≈ 1.3% dep-loc stream) → probe-2 (one var: w36.0 ≈ 6.6%)                                                                                                           | probe-1: decode 0/246 NZ + 0/69 GB, raw-BIO 2/69 gap 4.61. probe-2: decode **3/246 + 1/69 — first emissions ever**, raw-BIO 12/69 min-gap 0.000                                                                                          | **Confirmed as a confound, then superseded.** The feed run (8k, 4-locale at a matched 6.66% density) went back to 0/246 + 0/69 on both layers. Density alone does not keep the tag alive |
| 2   | **Encoder drift** — re-burial caused by the encoder moving under the head                                          | cRT probe `v3.12.0-crt-probe` (frozen encoder, 12,705 trainable params, ~5 min GPU), 1k–8k                                                                                                    | Reproduces the re-burial curve with the encoder frozen: GB raw-BIO 3/69→1→0→4, gap erosion 4.591→4.867; decode 0 throughout; digit board tracks feed within 1pp at every checkpoint (0.895/0.848/0.795/0.870 vs 0.890/0.853/0.782/0.868) | **Falsified.** Re-burial is a **classifier equilibrium** rather than representation drift. Side finding: much of the digit board's sensitivity comes from the classifier layer           |
| 3   | **Late-save / data-order anomaly** — the 7850–7950 train-loss bump immediately before the 8k save caused the break | `v3.11.1-deploc-consolidate`: resume feed-8k +2k at damped classifier LR                                                                                                                      | Comma-drop break **byte-identical 8k ≡ 10k**; every other guard PASSes at 10k (golden-us at 0.06pp margin)                                                                                                                               | **Falsified.** The break is stable learned behavior rather than churn. Stop rule #1 was executed, and v3.11.x is closed                                                                  |
| 4   | **Comma-share** — dep-loc extracts ~100% comma-structured promoted commas to required boundary evidence            | `v3.12.0-comma-robust`: Step-0-verified Fix B, `augment_punct_drop_prob` 0.3→0.6 (comma-free share 0.377, matched to base corpus; extracts measured 23.8–25.0%), 8k, all 8 checkpoints graded | Pennsylvania break new at **all 8** checkpoints (invariance suite + gauntlet agree); invariance-NEW 5–9 per checkpoint; gauntlet 3→3→3→3→**1**(5k)→**1**(6k)→**1**(7k)→3(8k, + new `BAND[transpose]` 1295.2km)                           | **Falsified.** The one pre-registered variable targeted exactly this failure class and did not change it in 8k steps                                                                     |

These four tests measured and closed four mechanisms. The full transcripts are in
`scratchpad/gb-probe-grade/{invariance,gauntlet}-cr-00[1-8]000.txt`, and the grades are in
`task-8-report.md` (§ Checkpoint sweep, § cRT probe curve, § v3.12.0 ship grade).

## 2. What we know is TRUE

- **Resurrection works.** Probe-2 produced the first production dep-loc emissions (decode NZ
  3/246 + GB 1/69, all tag-correct, and raw-BIO GB 12/69 with min-gap 0.000). The tag is
  learnable, so the null condition was never met.
- **The tag survives for a window of about 2k steps.** In the feed checkpoint sweep, GB raw-BIO
  any-fire peaks at 5/69 at step 2000 and falls to 0/69 at 4k, 6k, and 8k. Gap means worsen
  monotonically from 2k to 8k (GB 4.512→4.942, NZ 6.068→6.629). After about 2k steps at the hot
  LR, the 93% negative mass buries the tag again.
- **The pair prior converts marginal emission mass into full recall.** The three-way ablation
  (`2026-07-23-placetype-pair-scorecard.md`) gives v385+prior@δ6 = 3/69, feed+prior-OFF = 0/69, and
  feed+prior-ON@δ\* = **69/69 emit, 67/69 tag-correct (97.1%)**. Each ingredient is necessary. The
  fine-tune brings the tag within δ of winning, and the prior supplies the calibrated push.
- **The NZ allowlist fix works.** v3.12 produced the first NZ decode emissions (peak 5/246 at 6k,
  100% tag-correct where fired, and raw-BIO 15/246 at 6k). That raw-BIO count exceeds the 4
  firings from all 7 graded checkpoints of the v3.11.x lineage combined. Resurrection generalizes
  across locales once the extract reaches training (`country_weights NZ: 1.0`). The v3.11.x
  "4-locale" mass had silently been 3 locales.
- **Late in the run, the break narrows to one persistent class.** At v3.12 steps 5k–7k, the
  gauntlet shows exactly 1 violation, the Pennsylvania comma-drop. The NY-cell trio
  (num-ordinal/abbrev, the 350-Fifth-Ave 283.5km class) passes from 5k through 7k. At 8k the run
  regresses to 3 violations plus the new 1295km transpose. The best invariance-NEW count (5) is
  also at 7k. Late in the run, the model partially recovers on every case except Pennsylvania.

## 3. The surviving hypothesis space

Why does the Pennsylvania comma-drop break appear in all dep-loc-recipe runs and never in v385?
Every run shared four candidate factors: a hot classifier LR (1e-3, 10× base), reinit of rows 7/8,
about 3.2M dep-loc extract rows, and init_from v385.

**(a) The hot classifier LR itself reshapes US-tag decision boundaries.** The cRT side finding
supports this. The digit board moved under classifier-only training, within 1pp of the full-feed
curve, so classifier-layer updates alone can move US-shaped behavior.
_Cheapest probe (zero-GPU, ~hours):_ Run the gauntlet and invariance suites on the **cRT
checkpoints**. They are already exported and local (`task-8-report.md` § cRT probe curve), and
nobody has graded them on these suites. cRT has the hot LR and the reinit but a frozen encoder. If
the Pennsylvania break appears there, it lives entirely in the classifier head, which supports (a)
or (b) and rules out an encoder-side explanation. If the break is absent, it needs the encoder to
participate, which points at (c).
_GPU probe if needed (≤2k, ~$0.50):_ Run the feed recipe with the classifier LR at the base 1e-4
and the reinit kept. If the break is absent, the LR is causal. Dep-loc will not resurrect at the
base LR, which is acceptable for a diagnosis run.

**(b) Reinit of rows 7/8 perturbs the equilibrium of the shared classifier trunk.** Rows 7/8 are
re-drawn from the mean of the live rows. The softmax is competitive, so changing two rows changes
every other tag's decision margins at initialization.
_Cheapest probe (≤2k, ~$0.50):_ Run the feed recipe with the hot LR and **no reinit**, keeping the
rows from v385. If the break appears without the reinit, (b) is not necessary. If the break is
absent, the reinit is required for the damage. A zero-GPU complement is a cosine and margin
analysis of the non-dep-loc classifier rows in feed-8k against v385, reusing the row-7/8 cosine
instrument from the run-A adjudication on the other rows. Large drift in the `locality` or
`postcode` rows would directly implicate the trunk perturbation.

**(c) The 3.2M-row dep-loc mass shifts boundary-evidence statistics in a way punct-drop cannot
counter.** The augmentation drops commas, but the extract rows' comma-conditional structure may
differ from the base corpus in another correlated dimension. Candidates are token order (dep-loc
between street and locality), admin-token density per row, and P(field-boundary | comma) versus
P(boundary | whitespace). v3.12 showed that matching the comma-free share is not sufficient, so the
confound would be a second-order statistic.
_Cheapest probes (zero-GPU):_

1. **Pennsylvania logit-trace diff:** Dump per-token argmax and gaps for the comma and comma-free
   forms across v385, feed-8k, and v3.12-7k. Use the `TRACE_PRIOR_KINDS` and emission-dump
   plumbing in `neural/trace.ts` plus the raw-BIO primitives in `scratchpad/gb-probe-grade/`. The
   question is which token flips to which tag when the commas are removed. The answer identifies
   the mechanism under any hypothesis.
2. **Corpus-stat diff:** Compare boundary-evidence statistics (comma-conditional transition
   counts, admin density, field order) of the four extracts against the base stream.
3. **Eval-time ablation:** Invert the conditional-bias implementation
   (`conditional-bias-rescue.mjs`) to bias against rows 7/8 on the Pennsylvania input, and check
   whether resolution returns. The result shows whether the break is interference from the
   dep-loc rows or a broader boundary shift.

_GPU probe:_ Run 2k steps with the extract mass at ¼ weight. If the break vanishes, the mass is
causal.

**(d) Interaction.** This can be addressed only after the (a)–(c) results are in. The probe matrix
above is designed so that each run or analysis isolates one factor.

Zero-GPU order: grade cRT on the gauntlet, then run the Pennsylvania trace diff, then the corpus
stats and row-drift cosines. The first two will likely split the hypothesis space before any GPU
spend.

## 4. The option space (recommendation inputs rather than a decision)

**(A) Diagnose-first micro-arc.** Run the zero-GPU probes above, then one targeted run chosen by
their result, under a new pre-registration. This option gives the most information per dollar. It
follows the intent of the stop rule, which is to redesign from the mechanism rather than turn
another knob. Its cost is one more elapsed day before any model ships, and option D covers that
delay.

**(B) Two-phase schedule.** Train hot for steps 0–2k to resurrect the tag, then anneal
`classifier_learning_rate` to base for 2k–8k. No run has tried this yet. It was the original fork
option A from night #1, and it can now launch with one command. The resume-LR bug, where
`optim.load_state_dict` silently restored checkpoint LRs while the drift audit printed the new
values, was found and fixed (`62d73672` + `32b58ed4`, reviewed). The schedule targets the
confirmed ~2k window. The 5k–7k narrowing to a single violation suggests that the run partially
recovers late even at the hot LR, so an annealed tail should recover further. The risk is that if
hypothesis (b) or (c) is the cause, the break forms during the hot phase and annealing will not
remove it. The (a) probes in option A would reveal that first. A and B combine well: spend A's
zero-GPU day, then run B as the one targeted run if the trace evidence points at the LR or
schedule.

**(C) Accept-and-check.** Ship a 7k-class checkpoint and adjudicate the single Pennsylvania
violation as acceptable. **This option is not recommended.** The gauntlet metamorphic bar is a
pre-registered hard check that has held through two stop-rule executions. Waiving it after the fact
for a US-invariance regression on the best-known address in the eval set is the kind of check drift
that the pre-registrations exist to prevent. A new violation class relative to v385 is also a
regression that shipped users would hit, which is worse than a missing feature.

**(D) Locality-mapped v1 for the October talk.** en-GB ships on v385, which is already the shipped
state. The merged arc code was designed for this state: the prior is inactive but ready,
`neural-weights-en-gb` ships no model of its own, and the cards keep the v385 identity. The code
release from the night pivot (5 production bug fixes plus the en-gb package) is in flight. This
option carries no model risk and needs no GPU. The dep-loc distinction waits for the redesign.
**D can run alongside A and B.** D removes the risk to October now, while A→B proceeds at its own
pace. The talk material (resurrection window, pair prior, the regression the gauntlet caught)
already has receipts whether or not a new model lands first.

## 5. Costs

| Option                               | Agent-nights | Modal $ | Notes                                                                                         |
| ------------------------------------ | -----------: | ------: | --------------------------------------------------------------------------------------------- |
| A (zero-GPU probes + 1 targeted run) |          1–2 |   ~$2–4 | probes $0 (checkpoints local); one 2k probe ~$0.50; one 8k candidate ~$1.50 + export/quantize |
| B (two-phase schedule, one run)      |            1 |     ~$2 | 8k ≈ 25 min A100 ~$1.50 + export/quantize/grading; launch-ready today                         |
| C (accept-and-check 7k)              |          0.5 |      $0 | grading/battery only — but see not recommended                                                |
| D (v385 locality-mapped v1)          |           ~0 |      $0 | already the shipped state; code release in flight                                             |

A and B combined, the likely path if the operator wants a model this week, cost about 2
agent-nights and at most $5. Every earlier full run in this arc cost about $1.50 of GPU time. Money
is not the constraint. The constraint is getting information that can be attributed to one cause.

## Postscript (added during night #2): the cRT comma-drop diagnostic — hypothesis (c) substantially weakened

The main zero-GPU probe proposed above ran the same night on the already-local cRT checkpoints. A
grading agent took about 2 minutes. With the **encoder frozen for the entire run**, the
Pennsylvania `INV[comma-drop]` break is **absent at cRT-2k/4k/6k and present at cRT-8k**. The
failure signature (coordinate → 0,0) is identical to step 8000 of the full-fine-tune lineage, and
the invariance suite and the gauntlet each confirmed it independently.

Interpretation: The break originates in **classifier-head dynamics under the dep-loc-heavy stream**
rather than in encoder boundary statistics. That substantially weakens hypothesis (c) and
strengthens (a) and (b). The break appears late: the model is clean through 6k and broken by 8k,
which matches v3.12's narrowing to a single violation at 5k–7k followed by the 8k regression. That
timing fits an accumulation effect, where a hot classifier LR over long exposure degrades the head
after the resurrection window has already done its work. **Option B** (a two-phase schedule that
stays hot through the ~2k window and then anneals to the base LR) is designed to avoid exactly this
failure. B is now the favored run on mechanistic grounds. A's remaining probe (the Pennsylvania
logit-trace diff) becomes optional refinement rather than a prerequisite.

Receipts: `.superpowers/sdd/task-8-report.md` § "cRT comma-drop diagnostic".
