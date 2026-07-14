# 2026-07-13 — Parity campaign night 1: three cheap levers closed, the data lever confirmed

Conn granted ~01:30 UTC (operator nearby). Goal: execute the campaign runbook's probe sequence
(`docs/superpowers/plans/2026-07-13-parity-campaign-runbook.md`). Gate: `mailwoman eval parity`
(floors house_number ≥ 0.97, postcode ≥ 0.97, street ≥ 0.90; splice-candidate baseline
0.7273 / 0.9861 / 0.4033).

## What shipped

- **Router probe** (`mailwoman/dev-tools/router-kind-probe.run.ts`, committed): the `QueryKind`
  union has NO fragment kind; measured over parity-derived classes, bare streets scatter
  (locality_only 37/76, intersection 23, landmark 11) and are structurally inseparable from bare
  localities. **Routing path closed.**
- **Probe 0 — street-morphology bias** (`eval parity --street-morphology`, committed): floors move
  within noise (hn 0.7013→0.7078, street 0.3967→0.4000 on shipped weights) and AU full-agree
  REGRESSES 55→40% (unit/lot patterns flip toward street). **Capped-to-harmful at default scale;
  closed.**
- **Probe 0b — bolt-on CRF transitions** (`corpus-python/.../fit_crf_transitions.py`, committed;
  8M-row bigram fit, v0.5.0 corpus, label order from the model card): raw log-probs crater
  everything (postcode 0.9861→0.2083); row-max-centered still harms (street 0.4033→0.2200,
  postcode →0.8194). Candidate state verified restored after each. **Closed at both scales.**

Production state: unchanged (no HF/npm/demo changes; the v242 splice candidates on the data root
are unmodified).

## What went well

- **Characterize-before-fix paid three times.** Each closed lever cost minutes and produced a
  mechanism, not just a number: the router can't name fragments; morphology bias trades AU units
  for marginal street recall; a base-corpus sequence prior actively entrenches full-address order
  against the fragment distribution — which is positive evidence FOR the fragment-shard training
  thesis (the distribution mismatch is real and sequence-level).
- The `--weights-cache` grading path (PR #1099) made candidate A/B cycles trivial and
  channel-honest all night.
- A stale memory got corrected by reading source: the street-morphology prior was built
  (`neural/street-morphology-prior.ts`), not "designed, not built".

## What could've gone better

- The first transition fit launched against a ~573 GB corpus glob after misreading `du -s` KB as
  bytes — killed, zero output, ~4 min lost. `--max-files` sampling was the obvious opening move
  for a 33×33 count.
- Probe 0 ran on shipped weights while 0b ran on the splice candidate — deliberate (each probe vs
  its natural baseline) but the postmortem table below has to carry two baselines; next session
  should standardize on the candidate.

## Decisions made autonomously

- **Did NOT launch the GPU fragment-shard assay (probe 1).** The runbook allowed it; I held it.
  Reasons: shard synthesis + the #511 base-consistency scan deserve unhurried care (the scars are
  all about hasty shards), and every zero-training result tonight strengthened the case that the
  assay's job is confirmation of the span-head ceiling, not a hail-mary — it loses nothing by
  running early next session. Alternative was launching a rushed shard tonight; rejected.
- Treadmill-guard adjacent: stopped transition-scale exploration after two same-direction failures
  (raw, centered) rather than hunting a third temperature.

## Open questions (operator)

1. Probe 0's AU regression suggests the morphology bias needs per-pattern gating if it's ever
   revisited — park permanently, or file an issue?
2. Scoreboard grading (DeepSeek session 019f590a): prediction 1 HELD (bias didn't fix numeric
   neighbors), prediction 3 PARTIALLY HELD (fragment routing structurally poor — vocabulary gap,
   deeper than predicted; structured precision ~94% as predicted). Prediction 2 (assay residual
   signature) pends probe 1. Structural running total: 2/2 graded so far.

## Concrete next steps

1. Fragment shard synthesis (`corpus/` recipe: bare streets from dictionaries/FST by construction,
   street+trailing-number locale formats, truncations of existing gold) + the #511 source-scoped
   base-consistency scan — CPU, careful work, next session's opener.
2. Probe 1 GPU assay per runbook (short decaying schedule, eval every 500 steps, parity floors as
   early-stop; read-out = span-exact-match lag + trailing-number→postcode persistence).
3. If ceiling confirmed → #727 arc (GLiNER-lite span loss first), with variant-B (fragment-mixed)
   transitions refit available at train time via the committed fitter.

## Probe 1 — the fragment-shard assay (UPDATE, ~06:00 UTC)

Launched after the operator's course-correction ("the shift runs to 15:00 — complete the task"):
`v2.5.0-fragment-assay` on Modal (init_from the SHIPPED v241 step-012000, one lever = the
123,272-row balanced-polarity fragment shard at weight 6.0, lr 1e-5 constant, 6k steps, ~2h A100).

**Verdict: the data lever is REAL on the current architecture — DeepSeek prediction 2 FALSIFIED.**
All separators moved together (no span-exact lag): fragment-dev span-exact 0.142→0.481,
tag-accuracy 0.241→0.537, trailing-number→postcode 0.218→**0.084**. Parity: street
0.4033→**0.5333** (+13pp), house_number 0.7273→0.7532, postcode held 0.9861; FR full-agree
20→39%, NO 0→44%, DE 29→41%, **US held 41%**. Saturated at step 2000; NO late overfit through
6000 (the v196 scar did not reproduce at 1e-5/6k). Regression: AU 55→40% (the compact lot/unit
class the shard deliberately excluded — shard-v2 material).

Residual street failures after the assay are ~all mangle-class (offset bleed after diacritics),
i.e. exactly what the splice lever removes → **the consolidation run launched**:
`v2.5.1-fragment-splice` (v0.9.0-multisplice tokenizer, FVT mean-init-expanded v241 via the new
`mean_init_multisplice` modal fn, lr 5e-5/12k — the splice-adaptation idiom). Grades + the
standard gate set follow when it lands.

Data-integrity scar worth its own line: **zipping multiple pyarrow ChunkedArrays is not
row-aligned.** It silently fabricated the first #511 scan and biased the first transition fit to
the wof-admin block (base shards are source-homogeneous+ordered). Everything re-ran on
`iter_batches().to_pylist()`; `build_fragment_shard.py` carries the warning comment.

Scoreboard (session 019f590a): prediction 1 HELD, prediction 3 PARTIALLY HELD, prediction 2
**FALSIFIED** — structural 2/3. The falsification is the good kind: the cheap lever sufficed where
the consult predicted architecture work.

## The training arc (UPDATE 2, shift close): four runs, a gauntlet-green candidate

| run                        | one variable                         | parity (hn / pc / street)         | verdict                                                        |
| -------------------------- | ------------------------------------ | --------------------------------- | -------------------------------------------------------------- |
| shipped v241               | —                                    | .7013 / .9861 / .3967             | baseline                                                       |
| v2.5.0 assay (6k)          | fragment shard v1                    | .7532 / .9861 / .5333             | data lever CONFIRMED; pred-2 falsified                         |
| v2.5.1 consolidation (12k) | + multisplice tokenizer (mean-init)  | .7922@2k / .9444 / .5467@12k      | mangle cured at char level; pc regression classed (loc+pc gap) |
| v2.5.2 (8k)                | shard-v2: AU units + loc+pc polarity | .7597 / **.9861 PASS** / .5500@2k | pc restored; gauntlet FAIL: global-dublin-bare                 |
| v2.5.3 (8k)                | shard-v3: +11k global locality twins | .7403 / **.9861 PASS** / .5233    | **FULL GAUNTLET PASS** — staged, not promoted                  |

Iteration discipline held: each run changed one named lever answering the previous read-out's
classed failure — no knob oscillated (treadmill guard never fired). The Dublin→Melbourne
whack-a-mole exposed the durable design for shard-v4: DETERMINISTIC twins from the gazetteer's
top-population localities, closing the famous-city class instead of sampling instances.

Candidates staged with MANIFESTs: `models/candidates/v252-fragment-v2` (do-not-promote, Dublin
pin) and `models/candidates/v253-fragment-v3` (gauntlet-green; per-locale-F1 + error-analysis
legs and the operator's promote call outstanding).

## Numbers

|                     |                                                        |
| ------------------- | ------------------------------------------------------ |
| Shift               | ~01:30–03:50 UTC, 2026-07-13                           |
| Models trained      | 0 (three zero-training probes, by design)              |
| Modal GPU           | $0                                                     |
| Local compute       | ~6 parity evals (354 rows each), one 8M-row bigram fit |
| NaN incidents       | 0                                                      |
| Regressions shipped | 0 (all probe artifacts reverted; candidate verified)   |
| Levers closed       | 3 (router, morphology bias, bolt-on transitions)       |
