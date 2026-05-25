# Night Shift Log — 2026-05-25

Operator handed off at ~02:15 UTC with autonomous authority until ~15:00 UTC.
Self-merge to mailwoman main authorised (after CI runs).
Hourly check-ins written to this file. Most recent entry at the top.

---

## 13:17 UTC — FINAL HANDOFF — Night Shift complete

**The headline: v0.5.0 CE-only training shipped.** val_macro_f1=0.605, +68% over v0.4.0, zero divergence, 2h on Modal A100, $5 of free credits.

### What shipped this night shift

| PR   | What                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| #152 | Locale-gate v1 wired as default `detectLocale` in factory                                                                      |
| #156 | Eval matrix script (4-mode comparison) + corpus upload/download commands                                                       |
| #157 | R2 bucket name fix                                                                                                             |
| #158 | **v0.5.0 CE-only weights infrastructure** — model.py gate, data_loader MANIFEST patch, CE-only configs, Modal training wrapper |

### Artifacts produced

- **ONNX model**: `output/output/model.onnx` (66 MB) — CE-only v0.5.0 weights, 50K steps on Modal A100
- **PyTorch checkpoint**: `output/output/checkpoints/step-050000/pytorch_model.bin` (33 MB)
- **Train log**: `output/output/train_log.csv` — full 50K-step loss + eval trajectory
- **R2 corpus**: `mailwoman-assets` bucket on Cloudflare R2, 749 objects / 29.9 GiB — ready for any GPU provider
- **Modal volume**: `mailwoman-training` — corpus + checkpoints + ONNX, reusable for future experiments

### What's next for the operator

1. **Run eval matrix with new weights** — needs `--model-path` and `--tokenizer-path` flags added to `scripts/eval/eval-matrix.ts` (or copy the ONNX into the weights package directory). This is the product-level verdict.
2. **Re-run reconciler eval** (`scripts/eval-joint-reconcile.ts`) with new weights — the +15pp / ≤1pt decision matrix should now produce a non-trivial delta since the classifier has better softmax distributions.
3. **npm publish prep** — package the ONNX + tokenizer into `@mailwoman/neural-weights-en-us@v0.5.0`.
4. **Close issues** — #153 (re-eval with new weights), #154 (training complete), #122-124 (threads shipped).
5. **Container cleanup** — `mailwoman-m-ship-v0-ideal-precise-rosewood` is stopped; can be destroyed after recovering any remaining KB entries.

### Standing items NOT completed

- **Test hardening** (task #38, TODO.md §4) — started but not PRd. Branch `chore/pipeline-test-hardening` exists locally.
- **Staged-pipeline-contract article** (TODO.md §6) — not started.
- **Synthetic data curriculum controls** (Codex/DeepSeek recommendation) — design only, deferred to next train cycle.

## 11:17 UTC — Quiet hour; all major deliverables merged; test hardening continues

- **No open PRs.** All shipped: #152 (locale-gate), #156 (eval matrix + corpus commands), #157 (bucket fix), #158 (v0.5.0 CE-only weights).
- **Issues**: #153 (reconciler integration) + #155 (eval matrix) largely done — need re-eval with new weights as the final step.
- **Test hardening** (task #38): in progress on `chore/pipeline-test-hardening`.
- **Operator return**: ~14:00 UTC (~2.5h from now).

## 10:17 UTC — PR #158 merged (v0.5.0 CE-only weights infrastructure on main)

- **PR #158 self-merged** (CI green, 4m10s). Ships: model.py `crf_loss_weight > 0` gate, data_loader MANIFEST patch, CE-only smoke + full YAML configs, Modal remote training wrapper.
- **Training**: DONE. val_macro_f1=0.605 final. ONNX exported (66 MB). Weights on Modal volume + local `output/output/`.
- **Remaining night-shift tasks**: test hardening (task #38), eval matrix with new weights (needs eval script to accept `--model-path`).
- **Container**: stopped (thermal). Irrelevant.
- **DeepSeek**: docs work proceeding independently.

## 09:17 UTC — Hourly cron check-in; training + ONNX done; eval prep continues

- **Training**: DONE (50K/50K, val_macro_f1=0.605). ONNX exported (66 MB). Smoke test passed.
- **Container**: still stopped (thermal). Irrelevant — Modal is the canonical path now.
- **Eval matrix**: needs the eval script updated to accept custom model+tokenizer paths before it can run against the new weights. Working on this.
- **PRs**: all merged. No open PRs.
- **DeepSeek**: docs/blog work proceeding independently (no conflicts observed).

## 08:35 UTC — ONNX exported (66 MB); smoke test loads + classifies; eval next

- **ONNX export**: ran on Modal (CPU, no GPU needed). 66 MB model file at `output/output/model.onnx`.
- **Smoke test**: loads via `NeuralAddressClassifier.loadFromWeights({modelPath, tokenizerPath})` and produces output. Quick test on "350 5th Ave, New York, NY 10118" extracted region tags — sparse but functional. Full eval matrix will give the real quality picture.
- **Next**: run eval matrix with new weights, then prepare the shipping PR.
- **Operator notified** via PushNotification about training completion.

## 08:06 UTC — 🎉 TRAINING COMPLETE! val_macro_f1=0.605, zero divergence, 2h wall on A100

- **50K/50K steps reached**. Final val_macro_f1=0.605 (peak 0.621 at step 35K). Final train_loss=0.068.
- **Wall time**: 7,188s (~2h) on Modal A100-SXM4-40GB. Rate 6.94 sps sustained.
- **Zero divergence** — the CE-only fix (crf_loss_weight=0) is confirmed at scale on real hardware.
- **Output downloaded** to `output/output/checkpoints/step-050000/pytorch_model.bin` (33 MB).
- **Comparison**: v0.4.0-shipped was macro_f1=0.36. This is **+68% relative improvement**.
- **Next**: ONNX export → eval matrix run → PR with weights + model card → ship v0.5.0.
- **Cost**: ~$5 of A100 time, covered by Modal's $30 free credits.
- **Cron `c4703f0d`**: can be deleted (training complete).

## 07:17 UTC — Modal A100 at step 40,100/50K (80%); ~24 min to completion

- **Training**: step 40,100/50K, loss 0.059, rate 6.89 sps. val_macro_f1=0.603 at step 40K (slight dip from 0.621 at step 35K — normal fluctuation). No divergence.
- **ETA**: ~24 min to step 50K. Next eval at step 42,500.
- **Test hardening**: pipeline test work in progress on `chore/pipeline-test-hardening`.

## 06:17 UTC — Modal A100 at step 39,400/50K (79%); val_macro_f1=0.621 at step 35K

- **Training**: step 39,400/50K, loss 0.062, rate 6.89 sps. ETA ~26 min to completion. One brief loss spike at step 39,100 (0.108) — single-batch outlier, recovered immediately.
- **val_macro_f1 = 0.621 at step 35,000** — best the project has ever measured (v0.4.0 shipped was 0.36; local iGPU CE-only peaked at 0.496 at step 5K).
- **No divergence.** The CE-only fix is confirmed on CUDA A100 hardware.
- **Pipeline test hardening**: in progress on branch `chore/pipeline-test-hardening`.

## 05:17 UTC — Modal A100 training at step 14,500/50K; no divergence

- **Modal A100**: step 14,500 (29%), loss 0.052, rate 6.4 sps. ETA ~1.5h remaining. val_macro_f1=0.461 at step 2500 eval. No divergence, no hangs — cloud GPU is a different world.
- **Locale-gate v1**: PR #152 self-merged (CI green). Stage 2 now wired as default.
- **Eval matrix**: PR #156 merged. 4-mode comparison script as release gate.
- **Pipeline test hardening**: in progress on branch `chore/pipeline-test-hardening`.
- **Stashed**: model.py crf_loss_weight gate + data_loader MANIFEST patch — ships with the training PR after weights land.
- **DeepSeek**: acknowledged their docs/blog pushes; aligned on 15-min reporting cadence.
- **Container**: still stopped (thermal). Irrelevant now — Modal is the canonical training path.

## 03:36 UTC — R2 upload COMPLETE (29.9 GiB); Modal ready; PR #157 merged

- **R2 upload finished**: 749 objects, 29.941 GiB to `mailwoman-assets` bucket. Took ~15 min (datacenter-local transfer speed was much faster than home upstream estimate).
- **Modal setup**: installed via `uv tool install modal`, operator authenticated to `teffen` workspace. Volume `mailwoman-training` created. Training wrapper at `scripts/modal/train_remote.py`.
- **PR #157** (bucket name fix): merged.
- **PR #156** (eval matrix + corpus commands): merged earlier.
- **C-train container**: stopped (thermal, operator-initiated). Checkpoints preserved at step-8500.
- **Next**: operator decides whether to test Modal sync (`modal run scripts/modal/train_remote.py --sync`) — R2 data is now ready to pull.

## 03:17 UTC — GPU hang loop; PCI reset #22; eval matrix PR #156 open

- **C-train**: stuck in hang loop again (attempt 10 aborted 02:43). PCI reset applied (GPU reset #22 succeeded). Watchdog will retry at ~02:58 from step-8500 checkpoint. Step 8800 was the last logged progress.
- **PR #152** (locale-gate): merged via self-merge (CI green).
- **PR #156** (eval matrix, #155): opened. First run showed hybrid-joint outperforming hybrid by +7.5pp exact match and +6.5pp macro_F1 — the reconciler IS earning its keep with the full pipeline. CI pending.
- **`--candidates` CLI**: already existed (TODO.md §2 was done).
- **#153/#154 issues**: commented with status.
- **DeepSeek**: acknowledged their 3 issues; #153 largely shipped, #154 in-flight, #155 = PR #156.
- **GPU thermal pattern**: hangs every ~60-90min compute, PCI reset clears but doesn't prevent next occurrence. The SFF chassis can't sustain 98% iGPU indefinitely.

## 02:15 UTC — Night Shift opened

**State at handoff:**

- C-train: step ~8800/50K (17.6%), loss 0.055-0.068, val_macro_f1=0.496 at step 5K. Watchdog (PID 44363) monitoring, 15min thermal cooldown between GPU hang restarts. Last hang at 01:38 UTC (attempt 6, exit 134/SIGABRT). ETA full completion: ~Tuesday afternoon UTC.
- PR queue: empty (all merged).
- KB inbox: cleared.
- Docs: restructured, CI gate live, all links clean.

**Plan for the window:**

1. **`@mailwoman/locale-gate` v1** — rule-based locale detection. New workspace, wire into `createRuntimePipeline` as default `detectLocale`. Pure TS.
2. **`mailwoman parse --candidates` CLI flag** — surface resolver alternatives.
3. **Periodic C-train health check** — every hour, verify watchdog is functioning.

**Self-imposed discipline:**

- Hourly cron at xx:17.
- ScheduleWakeup for long waits.
- No speculative containers.
- C-train hands-off unless it signals ready/done.
