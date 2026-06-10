# Consolidation session — 2026-06-10 (parity flag-plant in flight)

A full-day session that closed the **country** and **affix** levers, ran the **v1.0.0
consolidation** (every proven lever in one model), and — when consolidation traded the
affix split + US postcode for a big spine win — used a DeepSeek consult + a cheap
diagnostic to reach consensus and launch the fix (**Run A**, in flight at write time).

> **⏯ RESTART NOTE.** The operator is restarting the Claude Code instance after the Run A
> watcher completes. The **"Resume after restart"** section below is the load-bearing part:
> it has the exact gate procedure, baselines, and decision tree to finish Run A cold.

---

## Resume after restart — finishing Run A (do this first)

**State:** `v1.0.1-consolidation-runA` is training on Modal, resumed from the clean
consolidation `step-040000`, running to **step-060000** (affix 5× + affix tag-loss-weight
2.0, country unchanged, no postcode aug). Output dir on the volume:
`output-v100-consolidation-s42/checkpoints`. Watcher was `bsbjjwmt0` (gone after restart —
just check the volume for `step-060000`).

**1. Confirm done, export, download:**
```bash
modal volume ls mailwoman-training output-v100-consolidation-s42/checkpoints | grep step-060000
modal run scripts/modal/train_remote.py::export_onnx --output-dir=/data/output-v100-consolidation-s42 --step=060000
modal volume get mailwoman-training output-v100-consolidation-s42/model.onnx /tmp/v101-runA.onnx --force
```

**2. Run the full gate (fp32; the model has the gazetteer anchor + choreography, so FEED the
lexicon + the paired suppression — without them score-affix zero-fills and wrecks segmentation):**
```bash
TOK=/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model
LK=/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json
GAZ=data/gazetteer/anchor-lexicon-v1.json
M=/tmp/v101-runA.onnx

# country homograph
node --experimental-strip-types scripts/eval/score-country-homograph.ts --model $M --suppress-gaz-near-postcode
# affix split (gaz-fed)
node --experimental-strip-types scripts/eval/score-affix.ts --model $M --gazetteer-lexicon $GAZ --suppress-gaz-near-postcode
# unit retention
node --experimental-strip-types scripts/eval/score-affix.ts --model $M --file data/eval/external/unit-real-designators.jsonl --gazetteer-lexicon $GAZ --suppress-gaz-near-postcode
# US/FR spine + FR postcode/house_number
node --experimental-strip-types scripts/eval/per-locale-f1.ts --model $M --tokenizer $TOK --model-card neural-weights-en-us/model-card.json --model-anchor-lookup $LK --gazetteer-lexicon $GAZ --suppress-gaz-near-postcode
# DE native-order tripwire
scripts/eval/de-order-eval.sh --model $M --card neural-weights-en-us/model-card.json --tokenizer $TOK --anchor-lookup $LK --out /tmp/v101-deorder
```

**3. Gate targets (consensus) and decision tree:**

| tag | target | v1.0.0 consol | diagnostic (20×, 2k) |
|---|--:|--:|--:|
| affix street_prefix | **≥72** | 27.6 | 75.0 |
| affix street_suffix | **≥64** | 42.1 | 55.8 (climbing) |
| country homograph | **≥85** | 87.5 | 83.3 |
| US postcode | **≥97** | 95.8 | 97.4 |
| unit | ≥91 | 92.1 | 92.1 |
| US micro | ≥85 | 85.5 | 85.0 |
| US region / locality | hold ~90 / ~76 | 89.7 / 75.9 | 89.5 / 74.5 |
| FR postcode / house_number | ≥99 / ≥91 | 99.6 / 92.3 | 99.6 / 92.8 |
| DE native loc (anchor ON) | ≥83.8 | 90.7 | — |

- **All clear → SHIP the v1.0.0 flag-plant.** Quantize int8 + release (npm ← HF bucket,
  demo ← R2) per the v4.1.0 playbook ([[project-v4.1.0-release]]); watch the int8
  value_info-strip quant fix. Promote as **v4.2.0**. This is the parity flag-plant.
- **suffix short but >55 and climbing** → it just needs more steps; continue-resume
  `step-060000` another 10–20k at the same recipe (cheap; momentum preserved).
- **country < 85** → affix 5× still slightly starved it; drop affix to 3–4× and re-resume.
- **US postcode < 97** → genuinely under-converged or structural after all; resume longer,
  and only then revisit DeepSeek's postcode-position augmentation.

Baselines for context (fp32, same harness): **v4.1.0** US postcode 98.3 · US street 78.5 ·
US locality 60.0 · US region 78.4 · US micro 80.2 · FR postcode 99.5 · FR house_number 91.0.
**v0.9.8** US street 80.4 · US micro 81.6 · FR house_number 92.0.

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
