---
slug: night-shift-2-model-ships
title: Night Shift 2 — from thermal hangs to a shipped model in one session
authors: [teffen]
tags: [training, infrastructure, modal, night-shift]
---

The second night shift ran from roughly 2am to 2pm UTC on May 25th, 2026. It started with a GPU that wouldn't stop crashing and ended with a trained model, an ONNX export, and a full evaluation report. This is the story of how infrastructure choices turned a hardware problem into a non-issue.

{/* truncate */}

## The hardware wall

The lab runs on a small form factor desktop with an AMD Radeon 780M integrated GPU. For short bursts — a 2-minute smoke test, a 10-minute diagnostic probe — it works fine. For sustained multi-hour training at 98% GPU utilization, it overheats. The firmware detects thermal stress and resets the GPU, killing whatever process was running on it.

During this session, the GPU hit 22 resets before we stopped counting. Every 60-90 minutes of training, the hardware would fault. A watchdog script would wait 15 minutes for the chassis to cool, then restart from the last checkpoint. Net progress: about 8,800 training steps out of a target 50,000.

At that rate — 90 minutes of compute, 15 minutes of cooldown, 500 steps lost per restart — the full training run would take roughly 38 hours of wall-clock time. That's fine for a research prototype, but it's not a productive use of a night shift.

## The pivot to Modal

[Modal](https://modal.com) is a cloud compute platform where you write a Python function, decorate it with `@app.function(gpu="A100")`, and it runs in a datacenter with a proper GPU. No SSH, no Docker, no instance management.

The pivot took about an hour:

1. **Upload the corpus to Cloudflare R2** — 30 GB of training data, synced via rclone. This took about 15 minutes (the data was already on a fast local drive; the upload was bandwidth-limited but not painfully so).

2. **Write a Modal wrapper** — 20 lines around the existing training script. The wrapper pulls the corpus from R2 into a Modal Volume (a persistent disk), runs the train, writes checkpoints back.

3. **Debug three small issues** — the Modal worker needed the R2 credentials passed as secrets (first attempt used empty env vars), the training config wasn't on the volume yet, and the ONNX export needed `onnxscript` added to the image.

4. **Run the training** — 50,000 steps on an NVIDIA A100-SXM4-40GB in 2 hours. No hangs, no resets, no watchdog. Just clean, uninterrupted compute at 6.9 steps per second (vs 0.56 on the local iGPU).

Total cost: about $5, covered entirely by Modal's $30/month free credits for new accounts.

## The results

The CE-only model (which drops the problematic CRF loss term that caused nine previous runs to diverge) trained to completion:

- **val_macro_f1: 0.605** (final), 0.621 (peak at step 35K)
- **Train loss: 0.068** (final)
- **Zero divergence** across all 50,000 steps
- **ONNX export: 66 MB**

For context: v0.4.0 shipped at macro_f1 = 0.36. This is a 68% relative improvement on the same evaluation set.

## The eval matrix

After the model shipped, we ran the full product-level evaluation — four pipeline modes compared on 4,535 hand-curated golden addresses:

| Mode | Exact Match | Overconfident-Wrong |
|---|---|---|
| Rule-only | **30.8%** | 2.4% |
| Neural-argmax | 0.1% | **54.5%** |
| Hybrid-joint (reconciler) | 6.0% | **0.1%** |

The headline finding: the neural model has a calibration problem (54.5% overconfident-wrong means it says "I'm sure" when it shouldn't be), but the reconciler fixes it (0.1% overconfident-wrong by checking whether parsed components form a coherent real-world hierarchy).

The rule-only parser still wins on exact match (30.8% vs 6.0%) because it has perfect precision on the patterns it knows. The gap is the neural model's per-component accuracy — addressable in the next training iteration via class-weighted cross-entropy, which is now safe to use because the dual-loss instability is resolved.

## The infrastructure lesson

The overnight session could have been a write-off. A GPU that crashes every 90 minutes, a 50,000-step training target, and 12 hours of wall-clock to fill. Instead:

- **Corpus on R2** means any GPU provider can pull it at datacenter speed. Upload once, train anywhere.
- **Modal's per-second billing** means we paid $0 for data upload, $0 for debugging, and ~$5 for the actual GPU compute.
- **Checkpoints every 500 steps** on the Modal Volume means even if a Modal preemption happened (it didn't), we'd lose at most 7 minutes of work.
- **The same training script** ran locally (for smoke tests) and remotely (for the full run) without modification — the config just points at `/data/` which is either the local mount or the Modal Volume.

The local iGPU still has a role: smoke tests, gradient probes, quick 50-step experiments. The expensive runs go to the cloud. The separation happened naturally once we accepted that the hardware wall was real and not worth engineering around.

## What's next

The calibration gap is the clear next target. The model is good at identifying address components (val_macro_f1 = 0.605 on the training eval) but bad at matching the strict exact-match criterion on the hand-curated golden set. Class-weighted cross-entropy — which pulls the model's attention toward underperforming tags — was the v0.4.0 recipe lever that couldn't safely be tested because it destabilized the dual-loss training. Now that CE-only training is proven stable, class weights become safe to experiment with again.

The reconciler is also proven useful: it eliminates the model's overconfidence problem by refusing to commit to parses that don't form coherent hierarchies. Wiring it as the default path (rather than behind a feature flag) is the next architectural step.

## Where to look

- [Eval matrix report](/docs/evals/2026-05-25-v0.5.0-ce-only-eval-matrix) — full per-component breakdown
- [What the eval numbers mean](/docs/understanding/our-approach/what-the-eval-numbers-mean) — plain-English interpretation
- [Modal training wrapper](https://github.com/sister-software/mailwoman/blob/main/scripts/modal/train_remote.py) — the 250-line script that runs the whole thing
- [Dual-loss curvature conflict](/docs/concepts/dual-loss-curvature-conflict) — why CE-only works when nine dual-loss runs didn't
