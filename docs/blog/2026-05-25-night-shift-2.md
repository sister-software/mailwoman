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
- **ONNX export: 66 MB** (full-precision training artifact; the shipped weights are quantized to ~25 MB for the npm package, and smaller still for the browser demo)

For context: v0.4.0 shipped at macro_f1 = 0.36. This is a 68% relative improvement on the same evaluation set.

## The eval matrix

After the model shipped, we ran the full product-level evaluation — four pipeline modes compared on 4,535 hand-curated golden addresses:

| Mode | Exact Match | Macro F1 | Empty Parse | Overconf Wrong |
|---|---|---|---|---|
| Rule-only | **30.8%** | 22.0% | 6.3% | 2.4% |
| Neural | 0.1% | 7.3% | 0.3% | **54.5%** |
| Hybrid | 0.1% | 7.3% | 0.3% | 54.5% |
| Hybrid-joint (reconciler) | 6.0% | 16.6% | **0.0%** | **0.1%** |

A few things jump out:

**The neural model hallucinates components it shouldn't.** On the golden set, it invented a `dependent_locality` — a sub-city neighborhood — 956 times where none existed. That's not a calibration problem (it's not just overconfident, it's wrong), and it's not a decode problem (Viterbi with structural mask is already running). It's a training problem: cross-entropy treats every mislabeling equally, so the model never learned that `dependent_locality` is rare and should be emitted sparingly. Class-weighted CE — which was blocked in v0.4.0 because it destabilized the dual-loss training — puts a thumb on the scale: mislabeling a rare tag costs more. Now that CE-only training is proven stable, this lever is unlocked.

**Hybrid mode shows identical numbers to neural alone.** The hybrid mode fuses rule classifications with neural output, but in this iteration the raw neural decoder's overconfidence drowns out the rules — hence the identical numbers. The reconciler (hybrid-joint) is the mode that actually disciplines the merge.

**The reconciler fixes the honesty problem.** It drops overconfident-wrong from 54.5% to 0.1% by checking whether parsed components form a coherent real-world hierarchy. It also eliminates empty parses entirely (0.0% vs rules' 6.3%) — it always produces something, even if conservative.

**The rules are a ceiling. The neural model is a ramp.** Rule-only at 30.8% exact match is a mature system, hand-tuned over years. Each additional percentage point costs engineering time. The neural model at 6.0% (hybrid-joint) after one stable training run is learning from data, which means each new training run can improve across every component and every locale simultaneously. The 68% improvement from v0.4.0 to v0.5.0 is the trend that matters — and the ramp just proved it can climb.

## The infrastructure lesson

The overnight session could have been a write-off. A GPU that crashes every 90 minutes, a 50,000-step training target, and 12 hours of wall-clock to fill. Instead:

- **Corpus on R2** means any GPU provider can pull it at datacenter speed. Upload once, train anywhere.
- **Modal's per-second billing** means we paid $0 for data upload, $0 for debugging, and ~$5 for the actual GPU compute.
- **Checkpoints every 500 steps** on the Modal Volume means even if a Modal preemption happened (it didn't), we'd lose at most 7 minutes of work.
- **The same training script** ran locally (for smoke tests) and remotely (for the full run) without modification — the config just points at `/data/` which is either the local mount or the Modal Volume.

The local iGPU still has a role: smoke tests, gradient probes, quick 50-step experiments. The expensive runs go to the cloud. The separation happened naturally once we accepted that the hardware wall was real and not worth engineering around.

## What's next

Now that we have cloud GPU access at $5 per full training run, several decisions we made for the local hardware no longer apply. The v0.5.0 model was trained with constraints that made sense on a thermal-limited iGPU but don't make sense on an A100:

- **Hidden size 256** — we wanted 384 but fell back when it wouldn't train locally. The A100 has 40 GB of VRAM; 384 or 512 are trivial.
- **Effective batch 128 via gradient accumulation** (batch=16, accumulate 8 steps) — a workaround for limited GPU memory. The A100 can do batch 128 directly, which changes the gradient noise characteristics and potentially the training dynamics.
- **50,000 steps** — sized for "affordable locally." At 6.9 steps/second on the A100, 100K steps costs $10. We might be undertrained.
- **Phrase-prior conditioning disabled** — turned off during debugging and never turned back on. The architectural thesis was built around it.
- **Class-weighted cross-entropy disabled** — the v0.4.0 recipe lever that addresses the 956-FP hallucination problem is now safe to use.

The next iteration removes all of these constraints at once: h384, direct large-batch, phrase priors on, class weights on, longer schedule. Same corpus, same tokenizer, same CE-only stability fix — just the model the architecture was designed to produce. One A100 run, a few hours, covered by free credits.

## Where to look

- [Getting started](/docs/getting-started) — 5-minute install + first parse
- [Project status](/docs/status) — what ships today, per package
- [Eval matrix report](/docs/evals/2026-05-25-v0.5.0-ce-only-eval-matrix) — full per-component breakdown
- [What the eval numbers mean](/docs/understanding/our-approach/what-the-eval-numbers-mean) — plain-English interpretation
- [Modal training wrapper](https://github.com/sister-software/mailwoman/blob/main/scripts/modal/train_remote.py) — the 250-line script that runs the whole thing
- [Dual-loss curvature conflict](/docs/concepts/dual-loss-curvature-conflict) — why CE-only works when nine dual-loss runs didn't
