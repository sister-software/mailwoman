# Night shift 2026-06-13 — the fr.house_number recovery (postmortem)

_Draft, sketched as the shift runs. The RESULT section fills in when the v1.5.0-fr-order re-gate completes (~early)._

The mandate: recover the one regression v4.5.0 shipped with — fr.house_number 97.7 → 89.6, the model's order-blindness on postcode-first FR (#560) — without losing the bridge-retirement win. Same Opus-orchestrates-Sonnet structure as 2026-06-12.

## What shipped

- **Wave A — all three delegated, verified, merged** (each a single-concern Sonnet contract in a worktree):
  - **#561** — `scripts/build-fr-order-shard.mjs` (`synth-fr-order`): reversed-order FR shard mirroring the German both-order shape. Verified by independent build (0 oob spans, correct reversed-order house_number labels).
  - **#562** — NZ "Private Box" colloquial codex alias (#517), `officiallyInvalid` citation per the operator ruling. In-scope, CI-green.
  - **#563** — FR golden diversification: +150 OA-sourced rows across 56 localities + both orders, diluting the Sainte-Livrade share 98.8% → 78.8%. Verified: 0 components-not-in-raw.
- **Centerpiece — v1.5.0-fr-order retrain** on the v0.5.0 corpus + the `synth-fr-order` shard (685 train shards, weight 3.0). _Re-gate result pending._

## What went well

- **Clean fan-out → verify → merge loop.** Three agents returned PR-ready branches; each verified by the orchestrator (diff-vs-merge-base, independent re-run of the build/eval) before merge. No worktree leaks this time — every diff was single-file/single-concern and in-contract.
- **The centerpiece overlapped the agents.** The moment Task 2 verified, its shard was folded into the corpus (R2 → sync_v050) and the retrain launched — the build-verify-merge of Tasks 3/4 happened while the retrain was already stepping. No serial waiting.
- **Verify-the-self-report paid off.** Task 3's agent mis-reported its baseline (claimed Sainte-Livrade 503; actual 582). The DATA was sound; the orchestrator caught the number error before it propagated into the PR/postmortem.

## What could've gone better

- **The `$RC`-string rclone shortcut broke** (zsh "file name too long") and the optimistic echo masked it — the R2 push silently no-op'd until I re-checked. Env-vars inline, never a long string var; never trust an echo over a verify.
- **The orchestrator session dropped mid-shift** (network). The Modal retrain was unaffected (detached), but the runbook and postmortem sketch were lost — recreated from the log. Lesson: commit scaffolding artifacts (runbooks, postmortem skeletons) to git even mid-shift; don't rely on the session surviving.

## Session continuity

- **The orchestrator session became unresponsive** (network issues) mid-shift, after launching the retrain and delegating Task 5 (prettier). The retrain continued running on Modal unaffected.
- **A local Claude session picked up** under a supplemental plan (`2026-06-13-NIGHT-SHIFT-PLAN-SUPPLEMENTAL.md`): verified state, recreated the missing re-gate runbook, completed Task 5 (prettier — 25 drifted files, format-only), and monitored the retrain to completion.
- **The runbook** (`build-logs/v150-regate-runbook.sh`) was claimed created but the `build-logs/` directory didn't exist — recreated from scratch using the `promotion-gate.sh` pattern.

## Decisions made autonomously

- **synth-fr-order weight = 3.0** (overrode the agent's suggested 0.2 — it lacked the source_weights scale; 0.2 would be negligible exposure, german order-lever precedent is 6.0). First-pass; bump if the eval shows weak reversed-FR signal.
- **Drove the sequential merge chain.** Confirmed the merge wall is not blocking me this shift (extended-trust grant) by merging #561 and watching it land — resolved last-night's ambiguity (it was me, not the operator). Then merged #562/#563.
- **Re-gate will use the diversified golden** (#563, now on main) and grade **actual-vs-v4.5.0, not vs the gate floor** (the floor understated the −8pp last time).

## Open questions

- _Does the FR shard recover fr.house_number to ≥95 without disturbing other tags? (re-gate, pending)_
- Is weight 3.0 right, or does it over/under-expose reversed FR?

## Concrete next steps

- Re-gate via `build-logs/v150-regate-runbook.sh` when step 40000 completes. Clean pass → v4.6.0 candidate → stage the four-store ship (the gotcha is recorded: HF bucket + nexus-public are separate; ship all `postcode-{us,de,fr}.bin`).
- The corpus-v0.5.1 code-point re-align (#558 lasting fix) remains DeepSeek's parallel track.

## Numbers (filled at finish)

|                         |                                                             |
| ----------------------- | ----------------------------------------------------------- |
| Wave-A tasks            | 3 delegated / 3 verified / 3 merged (#561, #562, #563)      |
| Centerpiece             | v1.5.0-fr-order retrain (step-2000 macro_f1 0.626, healthy) |
| fr.house_number re-gate | _pending_                                                   |
| Models trained          | 1 (v1.5.0-fr-order)                                         |
| NaN incidents           | 0                                                           |
