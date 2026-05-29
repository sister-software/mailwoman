---
sidebar_position: 1
title: "Night 3 postmortem — v0.7 kickoff (calibration + postcode repair)"
tags:
  - evals
  - night-shift
  - postcode
  - v0.7.0
---

# Night 3 postmortem — v0.7 kickoff (2026-05-29)

**Posture entering:** v0.6.x HELD. v0.7 plan (calibration + postcode fix)
synthesized from the v0.6.x retrospective + DeepSeek turns 11–12.

## TL;DR — calibration result

**`label_smoothing=0.1` does NOT pass the v0.7 ship gate.** At 100K (int8, vs
v0.6.0@100K, held-out TEST): overconfidence-on-wrong **86.3% → 66.6%** (−20pp,
real win) and postcode recall **+4.6pp**, but the PRIMARY metric — harness pass
rate — is **flat-to-down** (14.6%→13.8%; 15.2%→14.1% +repair), and the
pre-publish gate **fires on house_number −6.0pp**. Calibration improves
*confidence quality* but not the *release metric*: the harness ceiling is set by
clusters calibration can't touch (intersections 0%, street/locality boundary
errors). This is the plan's "flat → structural pivot" branch. **Not promoted.**
Fork for the operator: gentler `ls=0.05` (iteration 2 of the 2-cap) vs pivot to
structural (#41 char-level encoder + larger model). See §0c.

## 0. Calibration 20K early-gate — PASSED

Overconfidence-on-wrong (≥0.9 conf on wrong predictions, TEST split):

| Model | wrong @ ≥0.9 | wrong-bucket mean | p50 |
| --- | --- | --- | --- |
| v0.6.0 (int8) | 86.3% | 0.956 | 1.000 |
| calib step-20K (fp32) | **64.2%** | 0.842 | 0.924 |

A 22pp overconfidence drop at 20K, confidence mass pulled off 1.0 and capped
~0.95 — the label_smoothing signature. On track toward the plan's ~50% target
by 100K. Early-kill gate did NOT fire; training continued. (fp32-vs-int8
caveat: the effect dwarfs any quantization artifact; final gate uses parity.)

## 0b. Calibration 50K interim full gate — MIXED→CONCERNING (under-trained)

Interim gate on the step-50K checkpoint (int8, parity with v0.6.0 int8) vs
v0.6.0@100K. **Caveat: calib is half-trained here; 100K is the fair compare.**

| Metric | v0.6.0@100K | calib@50K | |
| --- | --- | --- | --- |
| Overconfidence-on-wrong (≥0.9) | 86.3% | 65.4% | ✓ down (but ~65%, not ~50%) |
| Harness pass rate (PRIMARY) | 14.6% | 12.0% | ✗ down 2.6pp |
| Structural validity (#37) | 97.6% | 69.7% | ✗ down 28pp |
| Exact match (TEST) | 21.5% | 18.6% | ✗ down 2.9pp |
| locality recall | 36.9% | 27.3% | ✗ down 9.6pp |
| postcode recall | 74.8% | 78.4% | ✓ up 3.6pp |
| dep_locality | 0 halluc. | **+88 halluc.** | ✗✗ |
| subregion | absent | **+30 halluc.** | ✗✗ |

**Mechanism (not just under-training):** label smoothing flattens the target
distribution, so low-prior tags (dep_locality / subregion, class-weight 0.3)
that were suppressed now leak → hallucination explosion AND structural-validity
collapse (spurious spans + dropped anchors → stranded fragments). The *pattern*
(rare-tag leakage) is smoothing overcorrection, not uniform under-training.
The #37 checker earned its keep — it caught a regression the harness pass-rate
number alone would have under-weighted.

**Provisional read:** `label_smoothing=0.1` looks too aggressive. If 100K
confirms harness ≤ 14.6% + structural drop, the natural iteration-2 is
`label_smoothing=0.05` (gentler) — operator's call (2-iteration cap). Did NOT
kill the run: 100K is the fair comparison and the marginal cost is ~$4.

## 0c. Calibration 100K definitive gate — DOES NOT PASS

Full 100K run, int8-quantized for parity with the v0.6.0 int8 baseline,
evaluated on the held-out TEST split (read once for this release).

| Metric | v0.6.0@100K | calib@100K | verdict |
| --- | --- | --- | --- |
| Overconfidence-on-wrong (≥0.9) | 86.3% | 66.6% | ✓ −19.7pp (not the ~50% target) |
| Harness pass rate — PRIMARY (no repair) | 14.6% | 13.8% | ✗ −0.8pp |
| Harness pass rate (+postcode repair) | 15.2% | 14.1% | ✗ −1.1pp |
| Structural validity (#37) | 97.6% | 96.8% | ✓ (recovered from 50K's 69.7%) |
| Exact match (TEST) | 21.5% | 20.8% | ~ −0.7pp |
| postcode recall | 74.8% | 79.4% | ✓ +4.6pp |
| locality recall | 36.9% | 36.9% | = |
| street recall | 30.1% | 27.2% | ✗ −2.9pp |
| house_number recall | 77.7% | 71.7% | ✗ −6.0pp (>2pp gate) |
| dep_locality / subregion halluc. | 0 | 0 | ✓ (50K explosion was under-training) |

**Decision: DO NOT PROMOTE.** The plan's acceptance was "harness pass rate
improves AND overconfidence drops, per-tag within 2pp." Harness did NOT improve
(flat-to-down); house_number regresses 6pp. Calibration delivers better-
*calibrated confidence* (−20pp overconfidence — useful downstream for resolver
thresholding) and a postcode bump, but it is **not** the lever for the release
metric. The harness is capped by failure clusters calibration cannot move:
intersections (65 assertions, 0% neural), street/locality boundary errors,
venue. This is the plan's "flat + overconfidence↓ → structural" situation.

The artifact stays experimental on the Modal volume (`output-v070-calib`,
step-100000) + local int8 — **not uploaded to HF, not promoted**.

**Fork (operator / DeepSeek-delegated call), under the 2-iteration cap:**
1. **Iteration 2 — `label_smoothing=0.05`**: gentler smoothing may keep the
   confidence win without the house_number/street recall cost. Config staged at
   `v0_7_0b-calibration-ls005.yaml` (NOT launched). This is the LAST recipe
   iteration before a methodology rethink.
2. **Structural pivot (#41 + larger model)**: the plan's "flat → structural"
   branch. Attack the harness clusters directly (char-level encoder for the
   tokenizer-fragmentation that also blocks postcodes; capacity for boundaries).

My read: overconfidence dropping without harness moving says overconfidence
was **not the binding constraint** on the release metric — which argues for the
structural pivot over another calibration tweak. But `ls=0.05` is cheap (~$8,
~2h) and settles whether the per-tag regression was the 0.1 magnitude. Operator
picks; I staged the config either way.

## 0d. Why the harness didn't move — ceiling is COVERAGE, not confidence

Read-only cluster analysis of the 321/376 neural failures (v0.6.0 harness),
to inform the fork:

- **Failure clusters:** intersection 65, address.usa 56, functional 33,
  address.fra 24, then non-US/FR locales — nzd 22, nld 20, deu 17, aus/nor/prt/pol.
- **Mode:** 396 expected components are MISSED (model emits no such tag) vs 323
  labeled-but-wrong — i.e. ~55% of the gap is *missing labels*, not bad values.
- **Most-missed tags:** street ×197, house_number ×100, venue ×21.
- **Intersections: the model emits `intersection_a`/`intersection_b` in 0 of the
  65 failing intersection cases** — it never learned the tag (corpus gap).
- Only 9/321 failures are structurally invalid → failures are coherent-but-
  incomplete, not garbled.
- **Intersection root-cause (logit probe):** the `intersection_a/b` labels exist
  (indices 29–32) and the decode mask permits them, but on canonical
  intersections ("Broadway & W 42nd St", "Market St and Castro St") the model
  assigns intersection labels a **max probability of ~0.0001–0.004 across all
  tokens** — it never learned the tag (Stage 3 added the labels without enough
  corpus support). Not a decode bug; a corpus gap. No calibration or tokenizer
  change can recover a label the model assigns ~0 probability.

**Implication for the fork.** Calibration softens confidence on labels the model
*does* emit; it cannot create the missing street / intersection / foreign-locale
labels that cap the harness — which is exactly why `ls=0.1` left the harness
flat. And `#41` char-level fusion attacks tokenizer *fragmentation* (postcodes,
already handled by #35) — it does not obviously create those missing labels
either. The dominant harness levers are **corpus coverage** (intersection
templates; EU/Oceania locales — #40 OpenAddresses) and **capacity** (#43 larger
model) for street extraction (street recall 30%, 197 misses). Recommend the
operator weigh those against another calibration tweak: the data says the
release metric is coverage-bound, not calibration-bound.

## 1. What shipped

- **CI unblock (PR #193, merged):** the `docs-build` workflow was failing on
  `main` since 6f8ea75 — MDX parsed `<90%`/`<0.1ms`/`<100KB` in the v0.6.x
  retrospective as JSX tag-opens. Fixed (inline-code per repo convention),
  plus two latent broken links (`TBD` / "to be written" → real files) and
  three undefined blog tags. Local build green; merged, CI green.
- **#34 dev/test split (PR #194):** deterministic 90/10 stratified split of
  golden v0.1.2 → `dev/`+`test/` subdirs (backward-compatible). Reproducible
  (verified identical shas across runs). 4561 → 4105 dev / 456 test.
- **#35 postcode regex repair (PR #194):** decoder-side per-country regex pass
  that snaps/adds postcode spans. **Measured (v0.6.0 int8, 3096 entries):
  +135 fixed, 0 regressed; overall 75.9% → 80.2%.** GB/CA/DE/PT/PL/JP
  0–57% → 100%; FR 70.1% → 78.8%; US flat; NL 0% → 75%.
- **#31 calibration config (PR #194):** `label_smoothing=0.1` on the v0.6.0
  base, single variable. **100K-step run training on Modal** (`ap-gTMRO2VFQcgwsyXRm0jkOU`).
- **Eval tooling (PR #194):** `eval-error-analysis.ts` + `harness-v0-neural.ts`
  gained `--model/--tokenizer/--model-card` + `--postcode-repair` so the gate
  can measure the calibration checkpoint on the held-out TEST.
- **#33 locale pre-classifier — measured, not built (PR #194):** rather than
  build an MLP blind, measured the existing rule-based `@mailwoman/locale-gate`
  (4600 samples). Postcode-shape baseline: **65.9%** — GB/CA/JP detected, but
  **FR/DE/NL collapse to US** (shared `\d{5}`). Adding lexical features
  (diacritics, street morphology, toponyms) lifts to **82.0%** (FR 0→53%,
  NL 0→75%) but creates a **CA↔FR collision** (Quebec French looks like France).
  Conclusion: lexical features work and the #33 MLP is warranted *specifically*
  to disambiguate feature conflicts hand-rules can't — building it is the
  follow-up, the design question is answered.

### Baselines captured (v0.6.0, for the #31 gate)

| Metric | v0.6.0 | v0.6.0 + repair |
| --- | --- | --- |
| Harness pass rate (primary, 376 assertions) | 14.6% (55) | 15.2% (57) |
| Postcode-only harness (3096) | 75.9% | 80.2% |
| Per-tag recall on TEST (456) | locality 36.9%, region 66.6%, street 30.1%, postcode 74.8%, house_number 77.7%, venue 33.9% | — |
| Structural validity (#37, 376) | 97.6% | — |
| Overconfidence-on-wrong (TEST) | **85.5%** (≥0.9 conf on wrong; 1712/2003) | — |

A push-button gate runner (`scripts/eval/v07-calibration-gate.sh <calib.onnx>`)
runs all four measurements on the calibration checkpoint vs these baselines.

**Sharpened diagnosis:** structural validity is already 97.6% and the model is
85.5% overconfident *on its wrong answers* — so v0.6.x failures are confident,
structurally-coherent, *wrong* values. That is exactly what label smoothing
targets, which is why #31 is the binding experiment.

**Honest finding:** the postcode fix is decisive for postcode accuracy but
moves the *primary* harness metric by only +2 assertions — whole-address
assertions rarely fail on postcode alone; street/locality/venue/intersection
are the larger gaps. Postcode fix is necessary, not sufficient.

## 2. What went well

- Front-loaded the long-latency GPU run, then worked the backlog (commits,
  eval prep, milestone) while it trained — no idle waiting.
- The postcode repair was built **and empirically validated locally** (no
  training) — a complete, shippable, measured deliverable in one window.
- Caught two repair regressions before trusting the result (NL false-positive
  on a US ZIP+4 tail; longest-match-wins fixed it) — net +135/0.
- Captured all v0.6.0 gate baselines *during* training, so the calibration
  comparison is one command away when the model lands.

## 3. What could've gone better

- The harness resolves `@mailwoman/neural` to compiled `out/`, so the first
  repair measurement was a no-op until I recompiled. Lost one ~15s run.
  (Reinforces the repo's "compile first" rule.)
- Initial repair NL pattern required a space → missed glued NL postcodes and a
  ZIP+4-tail false positive. Two iterations to get to net-zero-regression.

## 4. Decisions made autonomously

- **CI unblock via PR, not direct main push.** Auto-classifier (correctly)
  blocked direct-to-main; routed through a reviewable PR. Operator merged it.
- **#35 as a decoder-side label repair (not a tokenizer change or emission
  prior).** A true "protect-before-SentencePiece" needs a retrained model;
  the no-retrain, highest-precision lever is snapping the decoded span to the
  regex match. Built with precision guards (longest-match-wins, SNAP-only for
  numeric shapes, local smear-clip) → 0 regressions.
- **Calibration base = v0.6.0, not v0_6_4.** Acceptance compares to "v0.6.0
  dev"; building label_smoothing on the diluted v0_6_4 synth recipe would
  confound calibration with corpus changes. Single-variable discipline.
- **Full 100K run with a 20K early-kill gate** (not a short probe). Budget
  ($30) covers it (~$8); 100K is directly comparable to v0.6.0@100K. Early-kill
  if overconfidence hasn't dropped by 20K.
- **In-training eval on full v0.1.2; authoritative TEST eval done locally,
  once.** Avoids risking the run by repointing the eval loader; keeps TEST as a
  clean held-out read.
- **Did NOT self-merge PR #194.** Auto-classifier blocked it (the merge
  permission came via the untrusted DeepSeek channel). Left open, test-passed,
  for the operator.
- **Did NOT promote/ship the calibration model.** It failed the gate (harness
  flat, house_number −6pp). Per ship discipline + the pre-publish eval gate,
  kept it experimental (volume + local), not uploaded to HF. Resisted the pull
  to "ship something" from a long training run.
- **Did NOT autonomously launch iteration-2 (`ls=0.05`).** Training is
  authorized, but the iteration-2-vs-pivot fork is a genuine judgment call at
  the 2-iteration cap, and the decision tree leans pivot. Staged the config,
  surfaced the fork, did not burn ~$8 on a possibly-wrong next iteration.
- **Ran the interim 50K gate** instead of only waiting for 100K — surfaced the
  (under-training) structural-validity dip early; did not over-react (didn't
  kill), and 100K vindicated that (validity recovered 69.7%→96.8%).
- **Trusted the verified milestone over the relayed message.** Treated training
  as authorized only after independently confirming the operator's GitHub
  milestone; later the operator's direct message removed all ambiguity.

## 5. Open questions (for the operator)

- **THE fork — what moves the harness next** (§0c + §0d). `ls=0.1` didn't move
  the release metric, and the §0d cluster analysis says why: the harness is
  **coverage-bound** (missing street/intersection/foreign-locale labels), not
  calibration- or fragmentation-bound. Three paths:
  - (a) **`ls=0.05`** — staged, last recipe iteration (~$8/2h). Cheapest; but
    §0d predicts it won't move the harness (it can't create missing labels).
  - (b) **`#41` char-level** — fixes tokenizer fragmentation; helps postcodes
    (already handled by #35), unlikely to create the missing labels.
  - (c) **Coverage + capacity** — intersection corpus templates + EU/Oceania
    data (#40) + larger model (#43). **The data favors this** for harness pass
    rate. My recommendation, for your call.
- **Merge PR #194** — test-passed; self-merge was blocked by the auto-classifier
  (the merge OK came via the untrusted DeepSeek channel; needs your direct OK or
  a human click). 8 commits: #34/#35/#37/#33 + eval tooling + calib config.
- **MANIFEST.json drift:** `data/eval/golden/v0.1.2/MANIFEST.json` is stale
  (says us=2936/fr=1545; files now 2956/1551). Untouched (eval-set metadata —
  didn't want to change it unilaterally). Refresh, or confirm it's frozen.

## 6. Concrete next steps

- **Decide the fork (§5).** If `ls=0.05`: `modal volume put` the staged config
  to the volume, then `modal run -d scripts/modal/train_remote.py --config
  v0_7_0b-calibration-ls005.yaml --resume none`; re-run `scripts/eval/v07-
  calibration-gate.sh <int8>` at 100K. If structural pivot: scope #41.
- **Merge PR #194** (or I can, with your direct OK).
- **Ship #35 by default?** The postcode repair is opt-in (`ParseOpts.
  postcodeRepair`). It's +135/0 on postcodes and is model-independent. Consider
  wiring it into the default `AddressParser` regardless of the calibration fork
  — it's a standalone v0.7 win. (Left opt-in this shift; default-on is a
  behavior change worth your sign-off.)
- **#33 MLP**: the lexical probe (82%, with CA↔FR conflict) confirms the model
  is warranted. Build `system-classifier/` per the Explore map when picked up.
- The calib-100K int8 is at `/tmp/calib-100k-int8.onnx` (+ `output-v070-calib`
  on the volume) if you want to inspect / A-B it.

## Numbers

| | |
| --- | --- |
| Shift start | ~04:46 CEST 2026-05-29 |
| Models trained | 1 (v0.7.0 calibration, 100K steps, complete) |
| Modal time | ~2h15 A100 (100K train) + 3 ONNX exports (~$15–18 of $30 budget) |
| Local compute | postcode harness ×3, harness-v0 ×3, per-tag ×3, probe ×3, locale ×2 |
| NaN incidents | 0 |
| CI failures fixed | 1 (docs-build) |
| Models promoted/shipped | 0 (calibration failed the gate — kept experimental) |
| Demo regressions | 0 (postcode repair: +135 fixed / 0 regressed) |
| Tasks landed | #34, #35, #37, #33 (measured), eval tooling — all in PR #194 |
| PRs | #193 (merged), #194 (open, 8 commits, test-passed) |
