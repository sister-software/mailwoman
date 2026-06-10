# Consolidation session — 2026-06-10 (parity flag-plant in flight)

A full-day session that closed the **country** and **affix** levers, ran the **v1.0.0
consolidation** (every proven lever in one model), and — when consolidation traded the
affix split + US postcode for a big spine win — used a DeepSeek consult + a cheap
diagnostic to reach consensus and launch the fix (**Run A**, in flight at write time).

> **⏯ RESTART NOTE.** The operator is restarting the Claude Code instance after the Run A
> watcher completes. The **"Resume after restart"** section below is the load-bearing part:
> it has the exact gate procedure, baselines, and decision tree to finish Run A cold.

---

## Resume after restart — finishing Run C (do this first)

**State (2026-06-10):** Run A (5×, resume) → affix 64.9/52.4, postcode 96.1. Run B (17×,
**init_from**) → affix 64.9/**48.8** (NO gain despite +70% weight), postcode 97.3, country 89.8.
**THE LESSON / my error:** Run B used `init_from` (fresh optimizer) instead of `resume`; a fresh
Adam can't re-steer the CRF into the narrow prefix→street→suffix basin — **momentum (resume)
matters more than weight** for this fragile split. The only config to ever beat affix 65 was the
diagnostic: **resume + synth-affix 20.0** → prefix **75** (suffix still climbing, not a transient).
~65 is NOT a capacity ceiling (country never collapsed). **Run C is now in flight** —
`v1.0.3-consolidation-runC`: **RESUME** the clean `step-040000` (Run A's 042k-060k deleted so
`--resume auto` finds it), **synth-affix 20.0** (the proven diagnostic value — NOT DeepSeek's "40.0"
arithmetic slip) + **suffix tag-loss-weight 4.0** (prefix 2.0), 15k → **step-055000** in
**`output-v100-consolidation-s42/checkpoints`**. Watcher was `bswo5ov09`.

**0. EARLY-ABORT CHECK (step-042000, ~4 min in):** export+score that checkpoint; if affix prefix
≈75 → confound fixed, let Run C finish. If ≈65 → the resume hypothesis is wrong → STOP, escalate to
a wider model (do NOT iterate further per the treadmill guard).

**1. Confirm Run C done, export, download:**
```bash
modal volume ls mailwoman-training output-v100-consolidation-s42/checkpoints | grep step-055000
modal run scripts/modal/train_remote.py::export_onnx --output-dir=/data/output-v100-consolidation-s42 --step=055000
modal volume get mailwoman-training output-v100-consolidation-s42/model.onnx /tmp/v103-runC.onnx --force
```

**2. Run the full TRAINING gate (fp32; the model has the gazetteer anchor + choreography, so FEED
the lexicon + the paired suppression — without them score-affix zero-fills and wrecks segmentation):**
```bash
TOK=/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model
LK=/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json
GAZ=data/gazetteer/anchor-lexicon-v1.json
M=/tmp/v103-runC.onnx

# country homograph
node --experimental-strip-types scripts/eval/score-country-homograph.ts --model $M --suppress-gaz-near-postcode
# affix split (gaz-fed)
node --experimental-strip-types scripts/eval/score-affix.ts --model $M --gazetteer-lexicon $GAZ --suppress-gaz-near-postcode
# unit retention
node --experimental-strip-types scripts/eval/score-affix.ts --model $M --file data/eval/external/unit-real-designators.jsonl --gazetteer-lexicon $GAZ --suppress-gaz-near-postcode
# US/FR spine + FR postcode/house_number
node --experimental-strip-types scripts/eval/per-locale-f1.ts --model $M --tokenizer $TOK --model-card neural-weights-en-us/model-card.json --model-anchor-lookup $LK --gazetteer-lexicon $GAZ --suppress-gaz-near-postcode
# DE native-order tripwire
scripts/eval/de-order-eval.sh --model $M --card neural-weights-en-us/model-card.json --tokenizer $TOK --anchor-lookup $LK --out /tmp/v102-deorder
```

**3. Training-gate targets + the trajectory so far:**

| tag | target | v1.0.0 consol | Run A (5×) | diag (affix 20.0, 2k) | Run B (17×) |
|---|--:|--:|--:|--:|--:|
| affix street_prefix | **≥72** | 27.6 | 64.9 | 75.0 | ? |
| affix street_suffix | **≥64** | 42.1 | 52.4 | 55.8 | ? |
| country homograph | **≥83.3** | 87.5 | 85.7 | 83.3 | ? |
| US postcode | **≥97** | 95.8 | 96.1 | 97.4 | ? |
| unit | ≥91 | 92.1 | 90.6 | — | ? |
| US micro | ≥85 | 85.5 | 85.5 | 85.0 | ? |
| US region / locality | ~90 / ~76 | 89.7/75.9 | 89.9/75.9 | 89.5/74.5 | ? |
| FR postcode / hn | ≥99 / ≥91 | 99.6/92.3 | 99.5/93.0 | 99.6/92.8 | ? |
| DE native loc (anchor ON) | ≥83.8 | 90.7 | 90.7 | — | ? |

Baselines (fp32, same harness): **v4.1.0** US postcode 98.3 · street 78.5 · locality 60.0 ·
region 78.4 · micro 80.2 · FR postcode 99.5 · FR hn 91.0. **v0.9.8** US street 80.4 · micro 81.6.

**Decision tree (with the operator's TREADMILL GUARD):**
- **Run B clears the training gate** (affix ≥72/64, country ≥83.3, US postcode ≥97, spine held)
  → proceed to the SHIP gate below. This is the v0-parity flag-plant model.
- **One gate short, single-direction** (e.g. suffix still <64 but country fine) → one more
  resume nudging that knob is OK.
- **TWO gates short in OPPOSITE directions** (e.g. affix still <72 AND country <83.3 — pushing
  one needs the weight the other can't give) → **STOP. This is a FORK, not a branch. No 3rd
  recipe iteration solo — consult DeepSeek first.** (The v0.6.x-treadmill rule; consolidation is
  where it bites.) DeepSeek's pre-named capacity-tell: if at Run B **step-8000** suffix <55 AND
  country <84.5, it's a genuine equilibrium ceiling for 29M params → escalate to a wider model
  (48M) or a dedicated affix head, do NOT keep tuning weights.

**4. SHIP gate — REQUIRED before tagging v4.2.0 (training-gate pass is necessary, NOT sufficient).**
The flag-plant claim is made on the artifact users get, with resolver-coupled behavior verified:
- **Honest-eval (VT holdout)** — this model moved locality +14 / region +10; resolver behavior
  changed and the per-tag spine evals don't see resolver interactions. Run `scripts/eval/honest-eval.sh`;
  **region-match + coord p50/p90 must hold** vs v4.1.0 ([[project-honest-eval-region-fix]]).
- **Demo presets** — functional tests before verdicts (house law, [[feedback-functional-before-verdict]]).
- **int8 spot-check** — quantize, then RE-RUN country + affix + per-locale on the **int8** artifact
  (watch the value_info-strip quant fix, [[project-v4.1.0-release]]). Claim parity on int8, not fp32.
- **Bookkeeping makes it real** — eval-ledger row, dated eval report, re-emit the parity scorecard
  at v4.2.0, and a row in **releases.mdx** (PR #489's "status and releases change together or not
  at all" contract — v4.2.0 is its first test).

**5. Merge debt — these merge to main BEFORE v4.2.0 is cut (RELEASING flows from main; a model whose
recipe lives on an unmerged branch reproduces the #480 gap):** **#468** (choreography) → **#469**
(affix reroll) → **`feat/consolidation-466`** (consolidation + Run A/B configs + assemblers). PR
**#489** (docs/releases page) is independent + conflict-free — merge any order. Operator-gated (merge wall).

**6. After the flag-plant — queue, not ad-hoc:** next substantive item is **#478** (arbitration
layer, zero-GPU — converts the model wins into "pipeline never worse than v0"). po_box/cedex do
NOT run standalone — they **ride the next consolidation-class run** (dilution lesson), so they're a
queue slot, not a now. Lossless decomposition (the agent's "#32") is **NOT in the triaged backlog** —
if it's the post-parity differentiator, it needs a fresh issue with a real spec + a deliberate slot
in **epic #488**, not an ad-hoc grab.

---

## What shipped / landed today

- **Country lever resolved, bookkept.** v0.9.12 gazetteer anchor = country **83.3 F1**
  (homograph, P95/over-fire 0). Choreography = **PR #468**. #464 closed; plan doc + memory
  updated. (Choreography later found NON-load-bearing for the postcode dip — see below.)
- **Affix multi-locale reroll = PR #469** (v0.9.14, corpus v0.4.11-affix-ml). Proved the
  FR-postcode fix (95.6→99.7) but was a lateral move on FR solo → carried into consolidation.
  #462 closed.
- **Consolidation v1.0.0** (corpus v0.4.12-consolidation, config `v1.0.0-consolidation.yaml`,
  40k): the strongest spine yet — **US micro 81.6→85.5**, region +10, locality +14, country
  **87.5**, FR postcode+house_number recovered, DE native loc **90.7** (beats Pelias 85.9).
  BUT **affix split crashed** (prefix 75→27.6) and **US postcode −2.5** (98.3→95.8).
- **DeepSeek consult + diagnostic → consensus** (session
  `consolidation-tradeoff-2026-06-10`; notes in `.agents/skills/deepseek-consult/`):
  - Affix is **scheduling-bound, not capacity-bound** (diagnostic: prefix 27.6→75 in 2k
    steps @ affix 20×, postcode even +1.6, spine flat).
  - **Weight-merge is unsound** for our from-scratch (non-fine-tune) solo models — would
    wreck the CRF transition matrix.
  - **US postcode needed convergence, not a structural fix** — improved +1.6 with zero
    postcode-position changes; the #468 choreography is not load-bearing for it.
  - Fix = **continue-resume** (cheaper than fresh) with affix 5× + tag-weights → **Run A**.

## What went well
- The cheap 2k-step diagnostic adjudicated a real strategy fork (scheduling vs capacity)
  for ~5 min of GPU before committing to a 35-min run. Reusable pattern.
- Caught the score-affix harness artifact (zero-filled gazetteer → fake affix crash);
  fixed the tool to feed the lexicon for gazetteer-trained models.
- Operator-in-the-loop on every GPU launch; DeepSeek consensus on the consequential fork.

## What could've gone better
- I framed the US-postcode dip as feature-channel interference and built choreography (#468)
  for it; the diagnostic showed it was mostly under-convergence. Choreography is still
  default-off/byte-stable and harmless, but it wasn't the right tool for that nail.
- Missed the affix-run step-2000 ping window (did git commits first; the run was faster than
  estimated). Fixed by setting the poller immediately on later launches.

## Open / next
- **Finish Run A** (above). Then, post-parity: po_box + cedex coverage shards (deferred from
  consolidation), and the **lossless decomposition** pivot (#32, typed `unknown` spans —
  zero-GPU, the post-parity differentiator).
- **Merge debt:** PRs **#467** (merged), **#468** (choreography), **#469** (affix), and
  branch `feat/consolidation-466` (consolidation + Run A configs + assemblers) are open for
  operator merge (night-shift merge wall). The volume already has all their code/corpus, so
  Run A isn't blocked — but main needs them merged for reproducibility.

## Numbers
| | |
|---|---|
| models trained | consolidation (40k) + affix diagnostic (2k) + Run A (20k, in flight) |
| consults | DeepSeek-pro 2-turn (`consolidation-tradeoff-2026-06-10`) |
| PRs/branches | #468, #469 open; `feat/consolidation-466` open |
| regressions shipped | 0 (nothing promoted; Run A gated) |
