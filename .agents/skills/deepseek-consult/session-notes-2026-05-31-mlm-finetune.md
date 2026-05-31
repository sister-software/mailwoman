# DeepSeek consult — MLM fine-tune recipe + comparison (2026-05-31, deepseek-reasoner, 3 turns)

Decides how to fine-tune from the MLM-pretrained encoder (output-v080-mlm-pretrain/step-020000)
and compare vs from-scratch, to judge whether pretraining helps. Full transcript: /tmp/ds_ft_msgs.json.

## RECIPE (both arms identical; ONLY encoder init differs)
- lr 5e-5, cosine decay to 0 over 40k steps, 2k linear warmup (NOT v0.7.2's constant 1.5e-4/100k —
  too-high constant LR washes out pretrained features).
- label_smoothing 0.1 on BOTH arms (shared calibration lever; dropping it would unfairly inflate the
  pretrained arm's apparent calibration win).
- CRF OFF (crf_loss_weight=0.0) both arms — matches what trained stably; avoids reintroducing the
  CRF-under-bf16 NaN. bf16.
- Aux-MLM-during-finetune: SKIP for the first decisive run. It needs a 2nd forward/step (~1.8x) +
  new supervised-hot-path code AND confounds the clean init-only comparison. Add only as a 2nd-round
  lever IF the clean comparison shows no signal. label_smoothing already covers calibration.
- v0.7.2 corpus recipe (v0.4.0 + source_weights + augmentation) otherwise. Shipped v0.7.2 (100k, old
  recipe, ls=0, crf=0) stays a LOOSE external reference only — the honest A/B is the fresh scratch arm.

## RUN MATRIX (staged for cost)
1. pretrained-init (init_from=step-020000), seed 42, 40k.
2. from-scratch, same recipe, seed 42, 40k.
3. Decision on the seed-42 resolver-Acc@1 delta (pretrained − scratch):
   - >1.0pp OR clearly negative → STOP, verdict now.
   - 0.3–1.0pp ambiguous → add seed 1234 to BOTH arms for a defensible mean.
   2-seed signal rule: mean gain ≥0.5pp AND both seeds same direction = clear.

## METRICS (compute for both arms, vs the fresh scratch baseline NOT v0.7.2)
- Calibration: ECE (10-bin) PRIMARY + fraction-wrong-at-≥0.9 — from RAW LOGITS (label_smoothing only
  affects loss, not forward probs, so the metric is clean).
- Harness pass-rate (Pelias-lineage regression gate, neural structurally ~19.8%).
- Resolver end-to-end Acc@1 (the product metric; neural 96.1% locality on 10k OpenAddresses).

## REVERT — REFRAMED (20k pretrain is under-trained, MLM loss still descending at 4.58)
- ANY positive signal (mean Acc@1 gain >0, OR harness > scratch, OR ECE lower) → scale pretrain
  20k→100k (continue from step-020000, same hyperparams) then re-run the fine-tune comparison.
- Drop pretraining ONLY if all metrics flat/worse AFTER the 100k pretrain attempt.
- (Supersedes the earlier 'harness<22% AND Acc@1 gain<1.5pp → drop' — that was too quick to abandon
  an under-trained pretrain.)
