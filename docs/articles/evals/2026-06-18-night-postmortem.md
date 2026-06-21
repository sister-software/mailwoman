---
title: "Night shift 2026-06-18 — v1.7.0 balanced boundary-shard retrain"
author: playpen-agent
date: 2026-06-18
draft: true
---

# Night shift 2026-06-18 — v1.7.0 balanced boundary-shard retrain

_Shift: 03:58–15:00 UTC. Goal: take the balanced boundary shard (the diagnosis-driven fix after v1.6.0
gated NO-PROMOTE) through build → #511 lint → recipe → retrain → gate. NO promote (operator wall)._

_(Living document — sketched as the shift runs; final numbers + verdict at the end.)_

> **CORRECTION (post-shift re-eval, 2026-06-18):** the PROMOTE recommendation in §6 is **retracted.** The shift benchmarked v1.7.0 against v1.5.1, which was never the production default — v1.5.0 is (md5-confirmed). Re-graded against v1.5.0 on the assembled coordinate, v1.7.0 is **flat** (US locality-match 83.8 vs 83.9, p50 3.3 vs 3.3 km) and **regresses country-homograph by 2.4** (the 83.3 floor is v1.5.0's real score, not stale). Verdict: **HOLD v1.5.0, do not promote.** Full re-eval: [v1.5.0 vs v1.7.0 head-to-head](./2026-06-18-v150-vs-v170-head-to-head.md); see the Addendum at the end.

## 1. What shipped

- **Phase 1 — balanced shard** (`a6da3500`): `build-boundary-stress-shard.mjs` weighted composition
  (was uniform). bare-locality 10.9%, hn-before:hn-after 7:3, original 4 shapes keep the bulk. Full
  v0.6.1-boundary-stress corpus built: 20k rows, 0% quarantine, manifest re-rooted clean (0 `/mnt`).
- **Phase 2 — #511 venue lint** (`a6da3500` + `scripts/lint-venue-vocab.py`): the lint flagged **9
  contradictory venue terms** (Fire 93% street, Veterans 94% street, City 68% locality, Hall/Memorial/
  Hospital/Recreation street, Town locality, Library/County street) — the Madison-as-street class.
  Replaced with venue-dominant tokens only (Clinic 98%, Practice 98%, Dental 100%, …).
- **Phase 3 — recipe** (`bf26474b`): `v1.7.0-boundary-stress.yaml`. One headline variable (the balanced
  shard); one stated hygiene co-change (lr constant→cosine — zero code surface, it was the config default).
- **Phase 4 — gate spec + blind-spot probe** (`d3e580fa`): `gates/v1.7.0-boundary-stress.json` +
  `street-recall-full-probe.ts` (DeepSeek's catch). Baselined: v1.5.1 33.7% / v1.6.0 37.9% full-address
  street-exact (v1.6.0 did NOT erode street — reassuring).
- **Phase 5 — sync + launch** (`7307eafb`): `sync_v061`, R2 push (501s rode the retries), launched
  `ap-dC3SU5VQdTQLVTwNdFp2Zq`. **Early-loss abort gate PASSED** (5.05→1.91 over 250 steps, decreasing).
- **Phase 7 — gate**: run finished (step-040000, after the resume). Exported → quantized → fetched
  (`./out/v170/model.onnx`). **4-target gate: NO-PROMOTE (1/4), targets ~flat vs v1.6.0** — fr-prefix 99.3
  (✓), street_suffix 55.3 (tag at target, street-span short), comma-less 57.0 (✗), hn-after 53.7 (✗). The
  balanced shard rebalanced (held the guardrail) but did NOT lift the boundary targets — they're flat, so the
  boundary lever needs more than rebalancing (weight, or capacity). Floors gate + locality-regression +
  street-recall probes + the record-matcher 3rd point running — the decisive question is whether the v1.6.0
  locality regression got FIXED.
  **COMBINED VERDICT: NO-PROMOTE — but the diagnosis-driven fix WORKED.**
  - ✅ **The v1.6.0 ship-blocker is FIXED**: floors `us.locality` **80.0** (floor 72.9) — recovered from
    v1.6.0's failing 66.2, now _above_ v1.5.1. The bare-locality shape + cosine LR did exactly what the
    probes predicted. Guardrail held end-to-end (no drift).
  - ✅ Blind-spot cleared: street-recall-full **35.0%** ≥ 32.7% floor (29 regressions, 4 "eaten" — small).
  - ✅ All other floors hold (us.street 75.7, fr.house_number 94.9, affix 98/93, arena 77, …).
  - ❌ **4-target boundary gate 1/4** — targets ~flat vs v1.6.0 (shard rebalanced, didn't advance them).
  - ❌ ONE red floor: `us.country_homograph_f1` 80.9 vs 83.3 — but the **v1.5.1 baseline (run after) reframed
    this: it is NOT a v1.7.0 regression.** v1.5.1 scores the _identical_ 80.9; the 83.3 floor is stale (from
    the older v4.x 85-89 models). v1.7.0 didn't touch country.
  - Record-matcher 3-point curve FLAT: v1.5.1 68.0 / v1.6.0 67.9 / v1.7.0 68.0 (boundary lever ≠ dedup lever).

  **THE v1.5.1 → v1.7.0 FLOOR DELTA (the definitive comparison — most important number of the shift):**
  locality **+5.1** (74.9→80.0), **fr.house_number +10.2** (`84.7→94.9` — v1.5.1 was _failing_ its own 87 floor),
  fr.region +7.1, fr.cedex +2.5, unit +1.5, micro/region +~0.7; us.street **−4.3** (80.0→75.7, above floor —
  a locality/street tradeoff), street_suffix −1.6, de −1.0; country **±0.0**. **v1.7.0 is a NET IMPROVEMENT
  over v1.5.1**, not just a regression-fix. The gate FAILs only on (a) a stale country floor v1.5.1 also
  fails, and (b) the capacity-bound 4-target boundary gate. Candidate shipped beside the canonical
  (`./out/v170/model.onnx`); NOT auto-promoted (the wall). The diagnostic arc is validated AND v1.7.0 beats
  the current ship — a stronger outcome than "the fix worked."

- **Stretch #1 — record-matcher curve** (`ed89dd4d` + reports): added a model-swap to `nppes-dedup-benchmark.ts`
  and ran the v1.5.1 + v1.6.0 baselines (TX, 300 NPIs). **Result: flat within noise** — org-name F1 68.0%
  (v1.5.1) vs 67.9% (v1.6.0), NPI 62.8 vs 62.6, baseline 61.0 vs 60.9. The read: **the boundary-parse
  lever does NOT move the NPPES dedup F1** — the benchmark's own pre-registered finding is "config dominates
  the model," and dedup is bottlenecked on org-name over-merge (#625/#603), not parse boundaries. So the
  synthetic boundary wins are real for the PARSE but don't translate to this real-world dedup task. v1.7.0
  joins as the 3rd point when it lands (expected ~flat).

### First eval (step 2000) — v1.7.0 vs v1.6.0

macro_f1 0.656 vs 0.631 ; locality 0.691 vs 0.684 ; street 0.842 vs 0.819 ; hn 0.990 vs 0.994. The balanced
shard isn't hurting the guardrail early; cosine LR should hold it at the end (the v1.6.0 drift fix).

At step ~4000 the guardrail dipped slightly (locality 0.659, street 0.812 — below step-2000) while macro rose to
0.666 — the normal mid-training re-balance. By step ~16000 it had RECOVERED and climbed _past_ step-2000:
locality 0.740, street 0.834, macro 0.690. And it's tracking MUCH healthier than v1.6.0 at the same point —
v1.6.0's locality had collapsed to ~0.61 by step ~14k; v1.7.0 is at 0.74. The balanced shard is holding the
guardrail where v1.6.0 traded it away. Cosine LR decaying (lr ~0.00009) should consolidate it. The gate decides.

Confirmed post-resume at step ~28-30k: locality 0.731, street 0.819, macro 0.702 (highest yet), cosine LR
down to 0.000022 — the guardrail is HOLDING through the decay, no end-drift (v1.6.0 had drifted locality to 0.656
by its end). A noisy 0.623 reading near step 20k was a transient. The gate is the authoritative check.

## 2. What went well

- **The #511 lint paid for itself the first time it ran** — 9 contradictions caught before they could
  fight the base. My first venue draft was naive; the discipline (scan the source block, tally per token)
  worked exactly as designed. Strong argument for stretch-goal #4 (generalize the lint).
- **The DeepSeek consult was decisive and self-correcting** — it caught the street-recall blind spot I
  missed, and corrected my own walk-back (1:1 → 7:3) on the FR number ratio.
- **The runbook held** — every Modal gotcha (volume-put blindness, R2 501s, the zero-padded step) was
  already documented from the v1.6.0 run; Phase 5 went clean on the first try.
- **Pace** — Phases 1–5 in ~35 min of work; the prep was turnkey.

## 3. What could've gone better

- I'd been calling the model "9M params" (echoing the consult framing); it's actually **29.6M** (the #492
  ceiling size). Didn't change any conclusion, but I should verify the number, not echo it.
- **Generalizing the #511 lint is harder than it looked — and the experiment proved it.** The v1 uniform
  sample false-flagged FR cities as "street"; I tried PROPORTIONAL sampling to fix it and it got WORSE (more
  false-flags). Root cause: a token's correct tag is SOURCE/COUNTRY-specific (Paris = locality in FR data,
  street in US "Paris Ave"), so ANY cross-source aggregate mis-judges it — sampling can't fix it. The only
  fix is COUNTRY-scoped (check each shard token against same-COUNTRY base rows; the base has a `country`
  column). Reverted to the v1 caveated coarse-screen — its caveat ("re-check minority-source flags
  source-scoped") was right. The country-scoped lint is a real follow-up, and it will likely also surface
  some US-locality tokens (Marion/Glendale/Portsmouth) as street-dominant in US base — worth verifying
  before the next shard. (v0.6.1 itself: the FR-city + affix-split flags are false/expected; the venue +
  country tokens were linted source-scoped and are clean.) **A third attempt — a US-scoped spot-check of the
  flagged localities — was ITSELF sample-biased** (a small tiger/nad-heavy sample read Indianapolis 54%
  street, but the v1.6.0 verification has it 219700:29 LOCALITY — the small sample lied). FIRM lesson after
  three tries: judge a token's tag-dominance by FULL per-token counts, not a small scan; a small sample is
  street-biased because the street sources (tiger 39 + nad 378 parts) dwarf the locality sources. I then built
  the COUNTRY-SCOPED lint (v2, `lint-shard-vocab.py`) — the DESIGN is right, but **the SAMPLING is not, and
  the larger run proved it: the result is SAMPLE-DEPENDENT.** The 0.1 smoke CLEARED Paris (locality); the 0.5
  run FLAGS Paris 89% street and Lyon 100% street — and BOTH contradict the v1.6.0 full-block count (Paris
  515605:24789 = 95% LOCALITY). Sampling the first-N parts of ORDERED source blocks is biased. So the
  "prune-list" is BOGUS — it flags the very big cities v1.6.0 verified clean. **I got over-eager on the smoke
  and committed a wrong "found a real issue" claim; this corrects it.** The v0.6.1 vocab STANDS (v1.6.0
  full-count + v1.7.0's +5.1 locality gain). FIRM lesson (the sampling bit FIVE times): only a FULL per-token
  count is reliable for tag-dominance, AND validate any new lint against a KNOWN case (Paris) before trusting
  its flags. The lint needs a true full-count mode (all parts/rows, no sampling) — the real follow-up; the
  sampled modes are all biased. STOPPED here — over-invested, and the honest output is "the tool isn't trustworthy yet."
- _(more as the shift runs)_

## 4. Decisions made autonomously

- **Venue vocab rewrite** (lint-driven): dropped 9 contradictory terms. Alternative was shipping them and
  letting the model fight the base — rejected per #511.
- **7:3 composition** over my own 1:1 — DeepSeek's reasoning (FR's own dominant order, shared cross-locale
  capacity) was sound.
- **The two new guards (bare_locality, street_recall_full) ride as gate-time standalone probes**, NOT
  floors-map keys — wiring unscored keys into promotion-gate-verdict.ts would FAIL loudly; the probes give
  the v1.5.1→candidate comparison directly. Lower surface for an unattended night.
- **Corpus version v0.6.1-boundary-stress** (incremental on v0.6.0, same v0.5.0 base) — signals "same base,
  improved shard."
- **Stall recovery (~05:55 UTC).** The first run (app ap-dC3…) STALLED at step ~21k — the highest checkpoint
  sat at step-020000 for ~35 min with no advance, loss healthy (0.66, no NaN), app still "running" and
  burning the A100. Diagnosed it as a hang (not a divergence) via the checkpoint-not-advancing signal (the
  logs replay-window, so the checkpoint is the only reliable step). Stopped the hung app and **resumed from
  step-020000** (`--resume auto`, app ap-wvqFyeCdRGtf3X2d0pmeGB) rather than gate a half-trained checkpoint —
  resume came up clean ("[resume-drift] none", cosine LR correct at lr 0.000077). Added a STALL-WATCH to the
  monitor: a 2nd stall does NOT trigger a 2nd resume — it gates the highest checkpoint instead (bounded risk).

## 5. Open questions (for the operator)

- **Promote v1.7.0?** — gated on the Phase 7 verdict; NOT promoted autonomously regardless (the wall).
- **us.street floor** — kept at the committed 74.0; the recipe's 80.4 is the pre-#492 shipped value. Worth
  re-anchoring to v1.5.1's measured us.street when convenient.
- **The NEW `us.country_homograph_f1` regression (80.9 vs 83.3).** The one red floor on an otherwise-fixed
  model. Likely the composition shift (the bare-locality rows added US "City, STATE" weight with no country
  token). Needs a quick diagnosis before the next iteration — is it real or eval noise, and does a small
  country-context addition to the shard recover it? **Operator call: worth a v1.7.1 to clear this one floor?**
- **The boundary targets are stuck (1/4).** The shard at weight 1.0 rebalanced but didn't ADVANCE the four
  shapes. The confidence probe said signal-not-capacity, so the next lever is more boundary signal — sweep
  the shard weight up (the recipe's pre-registered 1.5), now that the guardrail is protected by the bare-locality
  balance. Or accept that 29.6M params caps these shapes (the #492 ceiling) and bank the regression fix.

## 6. Concrete next steps

- **RECOMMENDATION: PROMOTE v1.7.0 (a net improvement over v1.5.1); do NOT bump the weight.** The v1.5.1
  baseline shows v1.7.0 wins the floors that matter — locality +5.1, **fr.house*number +10.2 (v1.5.1 was
  \_failing* its own floor)**, fr.region +7.1 — at the cost of us.street −4.3 (above floor). DeepSeek-confirmed:
  weight 1.5 is unsafe (amplifies the flat boundary signal, re-risks the guardrail — the lever that cratered an
  affix tag) and the 4 boundary targets are capacity-bound; don't chase them. The record-matcher flatness
  confirms the boundary lever doesn't move real-world dedup. v1.7.0 is the better ship.
- **Two stated gate decisions the promote needs (operator's call, not autonomous — the no-silent-drift rule):**
  (1) **re-baseline the stale `us.country_homograph` floor** 83.3 → ~80 (v1.5.1 fails it identically at 80.9 —
  it's not a v1.7.0 regression); (2) **re-frame the 4 capacity-bound boundary targets as WATCH-items**, not
  blockers. With both, v1.7.0 promotes with NO retrain.
- **Weigh the us.street −4.3 tradeoff.** Locality up / street down is the bare-locality emphasis (11%) shifting
  the guardrail. It's above floor and the gains outweigh it, but if street matters more, a future iteration could
  trim bare-locality to ~8-9% (less street erosion, keep most of the locality recovery). Tuning note, not a blocker.
- **Country PATCH staged (optional, not a must-fix)** — a country-bearing bare-locality variant (~12%
  "…, United States"/"…, France"; #511-linted, "USA" DROPPED as locality-dominant). Pushes country UP if the
  operator wants it: rebuild shard v0.6.2 + a short fine-tune from v1.7.0. Not needed to promote (the floor's stale).
- If the boundary shapes ever bottleneck production: revisit with a bigger model / a specialized second-pass
  (per DeepSeek), not more of the same shard.
- The diagnosis blog (`docs/research/2026-06-18-the-macro-went-up.mdx`) coda: fill the v1.7.0 result (the
  fix worked) + humanizer pass before publish.
- Follow-up: the `lint-shard-vocab.py` proper fix (source-proportional sampling).

## Numbers

| metric                        | value                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| shift duration                | 03:58–15:00 UTC (~11h)                                                                                      |
| models trained                | 1 (v1.7.0, full 40k after a mid-run resume)                                                                 |
| Modal GPU time                | ~4h (train + stall window + resume + export/quant)                                                          |
| local compute                 | shard builds, the gate + 5 probe evals (×2 models for the comparatives), 3 record-matcher runs, 3 lint runs |
| NaN incidents                 | 0                                                                                                           |
| training stalls               | 1 (hung ~step 21k; recovered via `--resume auto` from step-020000, no training lost)                        |
| CI failures                   | 0 (docs-build green on all commits)                                                                         |
| commits                       | 14                                                                                                          |
| demo / production regressions | n/a (no promote — candidate shipped beside canonical)                                                       |

## Addendum — promote retracted on re-eval (2026-06-18)

The shift's verdict (§6: "PROMOTE v1.7.0, a net improvement over v1.5.1") rested on a wrong baseline.
**v1.5.1 was never promoted** — it was the falsified weight-6.0 experiment (worse than v1.5.0's
weight-3.0). The production default is **v1.5.0** (model-card 4.6.0; md5 `4674d3…` ==
`model-v150-step-40000-int8.onnx`, the fr-order recovery model). Every §6 delta ("+5.1 locality",
"fr.house_number +10.2, v1.5.1 was failing its floor", "stale country floor") was measured against
that worse model.

Re-anchored to v1.5.0 ([head-to-head](./2026-06-18-v150-vs-v170-head-to-head.md)):

- **US assembled coordinates: FLAT** — locality-match 83.8% vs 83.9%, coord p50 3.3 vs 3.3 km, p90
  10.7 vs 10.7. The locality F1 gain (real at the label level) does not reach the coordinate.
- **country-homograph: −2.4** (80.9 vs v1.5.0's 83.3). The floor is **not stale** — 83.3 is exactly
  v1.5.0's score. A real regression.
- **fr.house_number: FLAT** — anchor-on, both v1.5.0 and v1.7.0 score 99.3. The night's "+10" was an
  anchor-off measurement artifact (`per-locale-f1.ts` fed the model anchor-off; fixed in `d7b51748`).
- **FR coordinates: also flat** — 76.3% locality-match, p50 1.5 km, both models. The earlier "FR
  unmeasurable" reading was an eval-flag error (`--default-country` defaulted to US); with
  `--default-country FR` the resolver handles FR fine.
- Corrected per-tag (anchor-on): v1.7.0 is a small us.locality gain (+2.6) offset by us.street −4.0,
  fr.region −6.1, us.house_number −1.0, country −2.4 — not a net label improvement.

**Verdict: HOLD v1.5.0. Do not promote v1.7.0.** No coordinate-level case, plus a country regression.

**The lever moved.** The US coordinate misses are rural-gazetteer coverage (SD 62%, VT 31%
locality-match — identical across model versions), not model tagging. The model has caught up to its
database; the next US gain is in the gazetteer/resolver, not a retrain. v1.7.1 (street recovery)
won't change the coordinate picture and isn't worth the GPU.

**Process lesson:** confirm the production default by md5 against the shipped artifact before using it
as a baseline — don't assume the latest training run is the default. And grade the assembled
coordinate, not just the assembled per-locale F1. The shift fell into a one-level-deeper version of
the same trap the blog post warns about.

## Day session (2026-06-18 → 06-19) — the measurement-integrity campaign

The night's Addendum corrected one wrong baseline. The collaborative day that followed found the eval
lying in three more ways — and each time, pulling the actual records inverted the story. The theme of
the day was measurement integrity; the headline was that our flagship US coordinate was meter-grade
all along and the eval couldn't see it.

### The eval was lying — and the records kept inverting it

- **anchor-off scoring** — caught the night before (`d7b51748`).
- **wrong baseline** — v1.5.1 vs the real v1.5.0 default (the Addendum above).
- **the localadmin scoring artifact** — the "rural locality gap" (SD 62%, VT 31%) was the eval's
  `scoreTree` discarding `localadmin` New England towns; the resolver was landing the right place all
  along. Corrected → US locality-match 83.9 → 97.8% (`9f986ec3`).
- **the coordinate cascade** (the big one) — `oa-resolver-eval` resolved to the admin centroid (p50
  3.3 km) and never wired the situs cascade the geocoder actually ships. Graded against what ships,
  the same 10k rows are **p50 0.0 km, 85.9% within 100 m** — three orders of magnitude tighter
  ([situs-cascade-eval](./2026-06-18-situs-cascade-eval.md), `dd3628da`).

### This RETRACTS the Addendum's "lever moved"

The Addendum (above) concluded "the US coordinate misses are rural-gazetteer coverage (SD 62%, VT
31%)." Both halves were measurement artifacts: the SD/VT locality-match was the localadmin scoring
bug, and the coordinate "bottleneck" was the eval grading the admin centroid instead of the shipped
cascade. The lever was never the model nor the gazetteer — it was the measurement. The shipped US
coordinate is meter-grade.

### Shipped

- **#718 eval-integrity board:** the capability-manifest delta-gate + per-release mask-regression gate
  (the D2/#719 destructive-conventions-mask bug-class is now structurally impossible to ship); D1
  `loadFromWeights` soft-feeds the anchor + gazetteer channels by default; D3 re-derived the eval
  floors from anchor-on numbers; D4 region/county placetype-equivalence groups + a fallback flag.
- **Publish pipeline:** #720 (CI fetch places the soft-feed artifacts), #721 (the fr-fr card
  mis-described the en-us model it ships — reconciled + a drift-guard test), #722 (the eval parses via
  the canonical `createScorer` for ship-config parity).
- **The coordinate:** `--cascade` (grade what ships) + three admin-tail fixes — the directional-quadrant
  street-key fold, the US-gated 5-digit-house-number-as-ZIP relabel (FR reversed-order #560 verified
  untouched), and the spelled-ordinal fold. **Admin tail 12.0 → ~6.7%, within-100 m 85.9 → ~89.5%.**
- **Docs + outreach:** corrected the head-to-head, the HF card, and the situs-cascade doc to the
  shipped numbers; published the methodology blog post ("Three times this week, our metrics undersold
  us").

### Decisions

- **HOLD v1.5.0 confirmed.** The country −2.4 the night flagged is a single record (`Avenida Arequipa,
Lima 15046, Peru`) on a 27-row denominator — pulled the rows; not systematic.
- **Overture ingest is NOT the coordinate lever.** The situs shards are already built from Overture;
  the SD/IL holes are a NAD-vs-OpenAddresses theme-selection bug, not missing data (#723).
- **Banked the situs theme-reselect (#723).** The coordinate is in great shape; the shard rebuild
  (~+3.7 pts) is deferred, not launched.

### The lesson (a memory now)

Pull the records before a number changes a decision. This week the aggregate lied in both directions —
it inflated a regression (Peru), invented a coverage gap (localadmin/rural), and hid a
three-orders-of-magnitude win (the coordinate). Grade the thing the user actually receives.
