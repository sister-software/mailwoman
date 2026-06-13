# Night shift supplemental — 2026-06-13 (Claude session, local)

The Opus-orchestrated Sonnet-executed night shift (original plan at
`2026-06-13-NIGHT-SHIFT-PLAN.md`, log at `2026-06-13-NIGHT-SHIFT-PLAN.log`) became
unresponsive due to network issues. The centerpiece retrain is running on Modal and is
healthy. This supplemental plan covers what the local session can do while the training
runs — no GPU, no Modal launches, no training config changes.

## What the night shift completed (verified)

| Task                                 | Status          | Detail                                                                                           |
| ------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------ |
| 0 — v4.5.0 ship verification         | ✅ Done         | be458ab on main, registry confirms 4.5.0                                                         |
| 2 — Reversed-order FR shard (#561)   | ✅ Merged       | e0a9a50 — `scripts/build-fr-order-shard.mjs`, `synth-fr-order`                                   |
| 3 — FR golden diversification (#563) | ✅ Merged       | a0b877e — +150 OA-sourced rows, 56 localities                                                    |
| 4 — NZ "Private Box" codex (#562)    | ✅ Merged       | 8a09126 — `officiallyInvalid` citation per #517                                                  |
| 1 — Centerpiece retrain              | 🟢 Running      | Modal `ap-zYDsRqngUQwyOYjXseS4eM`, v1.5.0-fr-order, step ~15600/40000, healthy, ~1h to finish    |
| 5 — Prettier sweep                   | ❌ Not done     | Delegated to Sonnet agent; no branch/commit found. `yarn prettier --check` reports clean.        |
| Re-gate runbook                      | ❌ Not saved    | `build-logs/` directory doesn't exist — the claimed `v150-regate-runbook.sh` was never persisted |
| Postmortem                           | �️ Skeleton only | `docs/articles/evals/2026-06-13-night-13-postmortem.md` exists, needs results filled             |

## Ground rules for this supplemental shift

- **GPU/training is HANDS OFF.** The retrain is running on Modal — do not touch the app, the config,
  the volume, or R2. The only interaction is monitoring logs.
- **No second training run.** The centerpiece is the one retrain.
- **No schema changes, no ComponentTag changes, no corpus code-point re-align** (that's DeepSeek's
  parallel track).
- **Merge wall:** We can merge our own PRs (extended-trust grant confirmed operational).
- **Eval discipline:** Never re-baseline. Grade actual-vs-v4.5.0, not vs the gate floor.

## Our tasks

### S1 — Recreate the re-gate runbook

The `build-logs/v150-regate-runbook.sh` was claimed created but the directory doesn't exist.
We need the runbook to be turnkey when the retrain finishes.

The pattern is `scripts/eval/promotion-gate.sh`:

```
scripts/eval/promotion-gate.sh \
  --model <checkpoint.onnx> \
  --gate scripts/eval/gates/v0.5.0-bridge.json \
  --tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model \
  --card neural-weights-en-us/model-card.json \
  --gazetteer-lexicon data/gazetteer/anchor-lexicon-v1.json \
  --out-dir /tmp/gate-v150-fr-order
```

But the checkpoint path depends on where Modal saves the step-40000 checkpoint.
We need to:

1. Determine the output volume path from the training config/logs
2. Download the checkpoint when it's ready (`modal volume get`)
3. Create the exact runbook script with the correct paths

For now, create the skeleton with a placeholder for the checkpoint path.

### S2 — Prettier sweep (Task 5)

Wave A is fully merged to main. `yarn prettier --check` reports clean, but run it
explicitly to confirm nothing drifted, then commit if there are changes.

### S3 — Monitor the retrain

Poll `modal app logs ap-zYDsRqngUQwyOYjXseS4eM` periodically. Key milestones:

- Step 20000 eval (next checkpoint)
- Step 40000 completion
- Watch for NaN/divergence

### S4 — Re-gate when retrain finishes

Once step 40000 completes:

1. Download the checkpoint from the Modal volume
2. Run the re-gate via the runbook
3. Apply `MAILWOMAN_DUMP_MISS_TAG=house_number` to confirm reversed-order misses are gone
4. Collect results into the postmortem

### S5 — Complete the postmortem

Fill in `docs/articles/evals/2026-06-13-night-13-postmortem.md` with:

- Re-gate results (fr.house_number recovery, bridge-retirement hold, any regressions)
- Task 5 outcome
- Final numbers table

## Out of scope (same as original)

- The corpus-v0.5.1 code-point re-align (#558) — DeepSeek's parallel track
- Any new ComponentTag / schema change
- Any resolver/demo-DB swap
- Any second training run
- Anything that needs a product ruling — park it

## When the retrain finishes

The decisive question: does fr.house_number recover to ≥95 while bridge-retirement holds
(po_box ≥ 89.1) and no new regression appears vs v4.5.0?

- **Clean pass** → v4.6.0 candidate. Stage the promotion (int8 quant + gate delta + model
  card), flag the operator for the ship.
- **fr.house_number recovers but something else regresses** → finding, don't ship, report.
- **fr.house_number doesn't recover** → finding — the reversed-order shard wasn't enough;
  report and flag for the operator.
