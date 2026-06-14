# Night shift supplemental — 2026-06-13 (Claude session, local)

The Opus-orchestrated Sonnet-executed night shift (original plan at
`2026-06-13-NIGHT-SHIFT-PLAN.md`, log at `2026-06-13-NIGHT-SHIFT-PLAN.log`) became
unresponsive due to network issues. The centerpiece retrain is running on Modal and is
healthy. This supplemental plan covers what the local session completed and what remains.

## What the night shift completed (verified)

| Task                                 | Status     | Detail                                                                                        |
| ------------------------------------ | ---------- | --------------------------------------------------------------------------------------------- |
| 0 — v4.5.0 ship verification         | ✅ Done    | be458ab on main, registry confirms 4.5.0                                                      |
| 2 — Reversed-order FR shard (#561)   | ✅ Merged  | e0a9a50 — `scripts/build-fr-order-shard.mjs`, `synth-fr-order`                                |
| 3 — FR golden diversification (#563) | ✅ Merged  | a0b877e — +150 OA-sourced rows, 56 localities                                                 |
| 4 — NZ "Private Box" codex (#562)    | ✅ Merged  | 8a09126 — `officiallyInvalid` citation per #517                                               |
| 1 — Centerpiece retrain              | 🟢 Running | Modal `ap-zYDsRqngUQwyOYjXseS4eM`, v1.5.0-fr-order, step ~17500/40000, healthy, ~55 min to go |

## What the supplemental session completed

| Item                          | Status  | Commit  | Detail                                                                                                   |
| ----------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------- |
| S1 — Re-gate runbook          | ✅ Done | 3133954 | `build-logs/v150-regate-runbook.sh` — export ONNX → download → promotion gate + house_number lens        |
| S2 — Prettier sweep           | ✅ Done | cb2ea16 | 25 drifted files formatted, committed + pushed                                                           |
| Postmortem session note       | ✅ Done | 3133954 | Added session-continuity section to `docs/articles/evals/2026-06-13-night-13-postmortem.md`              |
| #481 — Parser hardening 2b    | ✅ Done | cc8b38d | Export ParseOpts, explicit compiled-tree detection (basename), named grouper NEUTRAL_PROPOSAL_CONFIDENCE |
| #379 — Repo housekeeping      | ✅ Done | 4c93bb2 | `.gitignore` night-shift plans, deepseek traces, diag scripts. 50+ untracked files suppressed.           |
| #523 — Placetype stamp        | ✅ Done | 4572ebf | `#fetchLocalitiesById` now reads actual placetype from spr (not hard-coded "locality") + regression test |
| #552 — imls phantom subregion | ✅ Done | 1422d23 | Dropped `subregion` component from imls adapter — US postal addresses don't surface counties             |

### Already done (confirmed during review)

| Issue                              | Evidence                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| #397 — stale `link-dev-weights.sh` | Already fixed: v4.4.0 model + MD5 drift guard (`#397 GUARD` in the script)                        |
| #376 — `--default-country` CLI     | Already implemented: `parse.tsx` + `localeToCountry` + `resolverDefaultCountry` + full test suite |
| #481 items 4, 6, 7 (partial)       | Already in prior commits: TLA removal, policy preference-filter tests, gazetteer validation       |

## What remains (for Claude when the retrain finishes)

| Item                       | Detail                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------- |
| S4 — Re-gate               | ✅ Run. Result: **fr.house_number 87.2% — DOES NOT PASS** (gate floor 91.0, target ≥95) |
| S5 — Postmortem completion | ✅ Done. Filled re-gate results, numbers table, verdict into postmortem                 |
| Ship decision              | ❌ No ship. Regression not recovered; reversed-order FR shard insufficient.             |

## Re-gate runbook (ready to run)

`build-logs/v150-regate-runbook.sh` — when step 40000 completes:

1. Exports ONNX from the checkpoint on Modal
2. Downloads artifacts locally
3. Runs `promotion-gate.sh` against `v0.5.0-bridge.json` (bridge OFF)
4. Runs `MAILWOMAN_DUMP_MISS_TAG=house_number` lens on FR golden

## Ground rules

- **GPU/training is HANDS OFF.** The retrain is running on Modal — do not touch the app, config,
  volume, or R2.
- **No second training run.** The centerpiece is the one retrain.
- **No schema changes, no ComponentTag changes, no corpus code-point re-align** (DeepSeek's
  parallel track).
- **Eval discipline:** Never re-baseline. Grade actual-vs-v4.5.0, not vs the gate floor.

## When the retrain finishes

The decisive question: does fr.house_number recover to ≥95 while bridge-retirement holds
(po_box ≥ 89.1) and no new regression appears vs v4.5.0?

- **Clean pass** → v4.6.0 candidate. Stage the promotion (int8 quant + gate delta + model
  card), flag the operator for the ship.
- **fr.house_number recovers but something else regresses** → finding, don't ship, report.
- **fr.house_number doesn't recover** → finding — the reversed-order shard wasn't enough;
  report and flag for the operator.
