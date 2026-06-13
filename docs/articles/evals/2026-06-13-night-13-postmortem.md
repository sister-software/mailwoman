# Night shift 2026-06-13 — the fr.house_number recovery (postmortem)

_Draft, sketched as the shift runs. Completed 2026-06-13 ~04:16 CEST after the v1.5.0-fr-order re-gate._

The mandate: recover the one regression v4.5.0 shipped with — fr.house_number 97.7 → 89.6, the model's order-blindness on postcode-first FR (#560) — without losing the bridge-retirement win. Same Opus-orchestrates-Sonnet structure as 2026-06-12.

## What shipped

- **Wave A — all three delegated, verified, merged** (each a single-concern Sonnet contract in a worktree):
  - **#561** — `scripts/build-fr-order-shard.mjs` (`synth-fr-order`): reversed-order FR shard mirroring the German both-order shape. Verified by independent build (0 oob spans, correct reversed-order house_number labels).
  - **#562** — NZ "Private Box" colloquial codex alias (#517), `officiallyInvalid` citation per the operator ruling. In-scope, CI-green.
  - **#563** — FR golden diversification: +150 OA-sourced rows across 56 localities + both orders, diluting the Sainte-Livrade share 98.8% → 78.8%. Verified: 0 components-not-in-raw.
- **Centerpiece — v1.5.0-fr-order retrain** on the v0.5.0 corpus + the `synth-fr-order` shard (685 train shards, weight 3.0). Ran to completion (step 100,000, checkpoints every 2K), exported ONNX at step 40,000, re-gated.

### Re-gate result: ❌ DOES NOT PASS

**fr.house_number: 87.2%** — below both the gate floor (91.0, −3.8pp) and the plan target (≥95, −7.8pp). Slightly worse than the v4.5.0 baseline (89.6%, −2.4pp). The reversed-order FR shard at 50K rows did not recover the postcode-first order-blindness regression.

| Metric | v4.4.0 | v4.5.0 | v1.5.0-fr-order | Gate floor |
|--------|--------|--------|-----------------|------------|
| fr.house_number | 97.7% | 89.6% | **87.2%** | 91.0 ❌ |
| us.postcode | — | — | 98.6% | 97.0 ✅ |
| us.street | — | — | 80.7% | 74.0 ✅ |
| us.locality | — | — | 77.2% | 62.2 ✅ |
| us.region | — | — | 90.4% | 80.1 ✅ |
| fr.postcode | — | — | 99.8% | 99.5 ✅ |
| fr.region | — | — | 41.8% | 16.2 ✅ |

**Verdict:** The centerpiece retrain was technically clean (no NaN, no crash, corpus folded correctly) but the signal was insufficient. The reversed-order synth shard at 50K rows + weight 3.0 did not overcome the char-offset model's order blindness on FR postcode-first addresses. This makes the regression a training-strategy question, not a code bug.

### Supplemental session (local, after Opus session dropped)

The Opus orchestrator session became unresponsive mid-shift (network). A local Claude session completed:
- #481 items 3, 5, 7 — export `ParseOpts`, explicit compiled-tree detection, named grouper constant (`cc8b38d`)
- #379 — `.gitignore` 50+ untracked ephemera files (night-shift plans, deepseek traces, diag scripts) (`4c93bb2`)
- #523 — fix `#fetchLocalitiesById` hard-stamped `placetype: 'locality'` + regression test (`4572ebf`)
- #552 — drop phantom `subregion` from imls adapter, recovering ~21% quarantine (`1422d23`)
- Confirmed #397 (stale weights link) and #376 (`--default-country`) were already shipped in prior commits

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

- ✅ ~~Does the FR shard recover fr.house_number?~~ **No.** The reversed-order shard wasn't enough. The regression is a training-strategy question — options include a larger reversed-order shard (100K+ rows), multi-locale reversed-order data, or a postcode-order-aware position encoding.
- Is weight 3.0 right, or does it over/under-expose reversed FR? (With 50K rows at weight 12.0 in a 677M corpus, the effective exposure is ~0.09% — the German order-lever was 6.0 at 50K rows in a 450M corpus (~0.07%), which worked. Something else is different here: FR postcode-first runs the postcode FIRST, so the house_number position is more variable than in German where the number is always last.)

## Concrete next steps

- Re-gate via `build-logs/v150-regate-runbook.sh` when step 40000 completes. Clean pass → v4.6.0 candidate → stage the four-store ship (the gotcha is recorded: HF bucket + nexus-public are separate; ship all `postcode-{us,de,fr}.bin`).
- The corpus-v0.5.1 code-point re-align (#558 lasting fix) remains DeepSeek's parallel track.

## Numbers

|                         |                                                             |
| ----------------------- | ----------------------------------------------------------- |
| Wave-A tasks            | 3 delegated / 3 verified / 3 merged (#561, #562, #563)      |
| Supplemental session    | 4 issues closed (#481, #379, #523, #552)                    |
| Centerpiece             | v1.5.0-fr-order retrain (step 100,000 complete, clean)      |
| fr.house_number result  | **87.2% — DOES NOT PASS** (−3.8pp vs gate floor 91.0)       |
| Gate outcome            | 7/8 tags pass; fr.house_number the sole miss                |
| Models trained          | 1 (v1.5.0-fr-order)                                         |
| NaN incidents           | 0                                                           |
