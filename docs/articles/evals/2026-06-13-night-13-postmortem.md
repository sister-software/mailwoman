# Night shift 2026-06-13 — fr.house_number recovery (postmortem)

_Shift complete. Two training runs, both gated. Result: a clean negative (weight is not the lever for fr.house_number — #564) plus a bonus Phase-3 de-risk (both coordinate-truth engines verified). Companion blog post: `can-you-fix-order-blindness-by-turning-up-the-volume`._

The mandate: recover the one regression v4.5.0 shipped with — fr.house_number 97.7 → 89.6, the model's order-blindness on postcode-first FR (#560) — without losing the bridge-retirement win. Same Opus-orchestrates-Sonnet structure as 2026-06-12.

## What shipped

- **Wave A — all three delegated, verified, merged** (each a single-concern Sonnet contract in a worktree):
  - **#561** — `scripts/build-fr-order-shard.mjs` (`synth-fr-order`): reversed-order FR shard mirroring the German both-order shape. Verified: 0 oob spans, 199/199 reversed-order span check PASS.
  - **#562** — NZ "Private Box" colloquial codex alias (#517), `officiallyInvalid` citation per operator ruling. In-scope, CI-green.
  - **#563** — FR golden diversification: +150 OA-sourced rows across 56 localities + both orders, diluting the Sainte-Livrade share 98.8% → 78.8%. Verified: 0 components-not-in-raw.
- **v1.5.0-fr-order retrain**: v0.5.0 corpus + `synth-fr-order` shard (685 train shards, weight 3.0). 40K steps, healthy (step-2000 macro_f1=0.626, 0 NaN).
- **v1.5.1-fr-order retrain** (launched ~05:00 UTC): same corpus + shard, weight bumped 3.0 → 6.0 (German precedent). Running on app `ap-1PoHJlr1GfFwoeoJgzO0up`.

### v1.5.0 re-gate result: ❌ DOES NOT PASS (but large improvement)

The gate ran on the diversified golden (n=1546, 56 localities, both orders). Key insight: **the baseline changed** — v4.5.0 only scores 54.5% fr.house_number on this harder golden (it fails on all reversed-order rows), so the comparison must be actual-vs-actual on the same golden.

| Metric               | v4.5.0 (new golden) | v1.5.0 (new golden) | Gate floor |
| -------------------- | ------------------: | ------------------: | ---------: |
| fr.house_number      |               54.5% |           **87.4%** |    91.0 ❌ |
| us.po_box_real       |                   — |               90.3% |    89.1 ✅ |
| de.native_locality   |                   — |               90.8% |    83.8 ✅ |
| us.postcode          |                   — |               98.6% |    97.0 ✅ |
| us.street            |                   — |               80.8% |    74.0 ✅ |
| us.locality          |                   — |               77.3% |    62.2 ✅ |
| us.region            |                   — |               90.4% |    80.1 ✅ |
| fr.postcode          |                   — |               99.9% |    99.5 ✅ |
| fr.cedex_real        |                   — |               94.2% |    70.0 ✅ |
| us.intersection_real |                   — |              100.0% |    50.0 ✅ |

**Net: +32.9pp fr.house_number improvement** (54.5% → 87.4% on same golden). Direction correct. Gate MISS by 3.6pp.

**Miss diagnosis (MAILWOMAN_DUMP_MISS_TAG=house_number):** Every single one of the 93 FR misses is the `47110 Sainte-Livrade-sur-Lot, <HN> <street>` format — the model still predicts `47110` (postcode) as house_number. The BAN canonical-order prior at weight=3.0 dominates. The shard is correct; the signal is just too weak.

Bridge retirement HOLDS (po_box 90.3%), German order HOLDS (native+anchor 90.8%). The rest of the US/FR spine is clean.

### v1.5.1 launch decision (autonomous)

Weight 3.0 → 6.0 matches the proven `synth-german` weight (which fully worked). Shard is already on the volume, no re-upload needed. Config committed as `728b67b`, pushed via R2 → sync_v050, training started. Re-gate runbook: `build-logs/v151-regate-runbook.sh`.

### v1.5.1 re-gate result: ❌ WORSE — weight is NOT the lever (REJECTED)

The weight-bump hypothesis is **falsified**. v1.5.1 (weight 6.0) scored fr.house*number **84.7%** — \_below* v1.5.0's 87.4% (weight 3.0). More reversed-FR exposure made it worse, not better.

| Run           | synth-fr-order weight | fr.house_number (diversified golden) |
| ------------- | --------------------: | -----------------------------------: |
| v4.5.0 (ship) |                  none |                                54.5% |
| v1.5.0        |                   3.0 |                     **87.4%** ← best |
| v1.5.1        |                   6.0 |                                84.7% |

**And it introduced a NEW failure mode: postcode fragmentation.** The v1.5.0 misses were clean ("47110 …" → predict `47110` as house*number — wrong span, intact tokens). v1.5.1's miss dump shows the model now \_splits the postcode*: `47110` → house*number `4` + postcode `7110`, and sometimes \_merges* it (`pred="47110 85"`). Over-weighting the both-order synth shard pushed the model to over-eagerly hunt for a leading house number, destabilizing the postcode boundary itself. Strictly worse.

**Conclusion — the both-order synth recipe plateaus at ~87% on this golden, and louder weight is actively harmful.** Likely mechanism: the generated synth distribution diverges from the real OA golden's reversed-order distribution; overweighting fits synth quirks at the expense of real rows. The German precedent (6.0) did NOT transfer — German's number is always _last_ (one position to learn); FR postcode-first makes the house_number position genuinely ambiguous (it can collide with the leading postcode), so more synth mass amplifies the collision.

**This closes the v1.5.x weight thread** (committed to the operator: "the last weight experiment"). No third training run tonight. The lever for a _future_ run is NOT weight — candidates: (a) more _real_ reversed-order data (BAN-sourced, not synth), (b) a postcode-anchor / position-aware signal that protects the postcode span, (c) accept ~87% as the honest intrinsic floor.

### Ship decision — operator's call (flagged)

The best recovery model is **v1.5.0 (87.4%)**: +32.9pp over v4.5.0 on the diversified golden, every other floor passing, bridge retirement intact, arena.perturb confirmed 78% (now that it's enforced — see gate-integrity below). It misses the pre-registered `fr.house_number` floor of **91** by 3.6pp. Two honest options, both the operator's to choose (no silent re-baseline):

1. **Ship v1.5.0 as v4.6.0 with a STATED floor re-baseline.** The 91 floor was inherited from v4.4.0, measured against the _easier_ pre-#563 golden (v4.5.0 itself scores only 54.5% on the new golden). The floor is arguably miscalibrated for the harder eval. Re-baselining is legitimate _if reasoned in the doc_ — but it's the operator's explicit decision, not a night-shift edit.
2. **Hold v4.5.0; pursue a different lever next session.** Keep the shipped model, treat 87.4% as a documented way-station, and attack the plateau with real-data / position-aware approaches.

My recommendation: **option 2 short-term** (don't ship a below-gate model on a recovery that's still 8pp shy of target), unless the operator wants the +32.9pp in users' hands now and re-baselines the floor deliberately.

## Bonus — Phase-3 de-risk (the strategically bigger finding)

With the centerpiece resolved and no GPU to spend, the idle hours went to mapping the forward path (`2026-06-13-FORWARD-SCHEDULE.md`) — and the diagnostic turned up something more important than the FR result: **the Phase-3 coordinate-truth layer is already built and verified, not greenfield as the #488 epic's unchecked boxes imply.**

- **#483 house-number interpolation** — engine built (two merged PRs #533/#542, 21/21 unit tests). The "VT still-MISSES the gate" status was **`--mode tiger`-only** (StreetInterpolator alone: ≤100m band p90 182m, opposite-side-fallback tail). Re-measured on the production **`--mode ladder`** cascade (Method 2 address-point bracketing → TIGER fallback), seeds 42+7: **PASSES every band** (≤100m p90 114–118m vs 150m bar, coverage 97.7%). Gate met, matching Cook County. Recorded on #483.
- **#484 reverse geocoding** — engine built (`reverse.ts`). The 4 production-gated tests (skipped without real DBs) **PASS** against the real gazetteer (`admin-global-priority.db`, 2 GB) + `wof-polygons.db` — all 13 green. Recorded on #484.

So both engines that turn the parser into a geocoder — street-level forward coordinates + coordinate→hierarchy reverse — **exist and work against real data today.** The remaining Phase-3 work is the **mechanical resolver-API wiring** (surface `resolution_tier: "interpolated"` / the reverse path in the public resolve API), not building or gate-chasing. That's the single clean, low-risk centerpiece between here and a real geocoder. All diagnostic — no code changed.

## What went well

- **Clean fan-out → verify → merge loop.** Three agents returned PR-ready branches; each verified by the orchestrator before merge. No worktree leaks — every diff single-file/single-concern.
- **The centerpiece overlapped the agents.** Retrain launched the moment Task 2 verified; Tasks 3/4 build-verify-merge ran while the retrain stepped.
- **Verify-the-self-report paid off.** Task 3's agent mis-reported its Sainte-Livrade baseline (claimed 503; actual 582). The DATA was sound; orchestrator caught the number error before it propagated.
- **Bridge retirement held clean.** po_box 90.3% with bridge OFF, every US floor passed — the v4.5.0 spine is solid.
- **Actual-vs-actual grading revealed the golden shift.** The diversified golden (#563) changed the baseline: v4.5.0 at 54.5% (not 89.6%) on the same n=1546 set makes the +32.9pp gain visible and attributable.
- **Caught a silent gate-integrity bug.** `arena.perturb` (a pre-registered floor, 71.0) was reporting `NOT FOUND` on every v0.5.0 gate — the compiled v0 arena parser couldn't find libpostal dicts (`core/out/data` vs `core/data` path mismatch). Root-caused, locally bridged (symlink + gate-script guard, commit `ab2a029`), and re-measured: the real perturb pass-rate is **78%** (neural) vs 39% (v0) — a clean pass that had been masked. Order-robustness is _already_ paying off in the arena: the perturb arena IS delimiter/case/order perturbation, and neural doubles the rules parser.
- **The negative result is clean and attributable.** Two runs isolated one variable (weight 3.0 vs 6.0); the falsification is unambiguous and the failure mode (postcode fragmentation) is diagnosed, not mysterious. That's $-worth of signal: we now know weight is the wrong lever and _why_.

## What could've gone better

- **The `$RC`-string rclone shortcut broke** (zsh "file name too long") — the R2 push silently no-op'd until verified. Env-vars inline always; never a long string var; never trust the echo over a verify.
- **The orchestrator session dropped mid-shift** (network). Modal retrain unaffected (detached), but the runbook and postmortem sketch were lost — recreated from log. Lesson: commit scaffolding to git mid-shift, don't rely on the session surviving.
- **Task 5 (prettier) hit Sonnet weekly limit** mid-wave A. Prettier sweep #7b deferred to 2026-06-14 (resets 9pm Paris). Not blocking.
- **arena.perturb NOT FOUND** in the gate output — this eval isn't being generated. Not a new regression (the gate floor was set historically) but the missing eval should be investigated.

## Session continuity

The orchestrator session became unresponsive (network) mid-shift after launching the retrain. A local Claude session picked up: verified state, recreated the re-gate runbook, completed backlog items (#481, #379, #523, #552), and monitored the retrain. The current session completed the re-gate and launched v1.5.1.

## Decisions made autonomously

- **synth-fr-order weight = 3.0** (initial, overriding agent's suggested 0.2; German precedent is 6.0). First-pass; documented in config as "bump if eval shows weak signal."
- **Drove the sequential merge chain.** Confirmed the extended-trust merge grant by merging #561 first, watching it land. Then #562/#563.
- **Actual-vs-actual grading on the diversified golden.** The gate floor (91.0) was set before #563; on the new harder golden, v4.5.0 scores 54.5% — the floor understates the regression direction.
- **v1.5.1 launch (autonomous, ~05:00 UTC).** Weight bump 3.0 → 6.0 based on: (a) all 93 misses are same postcode-first pattern, (b) shard verified correct, (c) German precedent at 6.0 fully worked, (d) 2.5h headroom before 15:00 UTC shift end. This decision is within the shift mandate (recover fr.house_number) and the extended-trust grant.

## Open questions

- **What recovers fr.house_number past the ~87% plateau, if not weight?** Falsified: weight (6.0 < 3.0). Untested candidates, for the operator to prioritize: (a) more _real_ reversed-order data from BAN rather than synth (the synth↔real distribution gap is the leading suspect); (b) a postcode-anchor / position-aware signal that protects the postcode span from being raided for a leading house number; (c) accept ~87% as the honest intrinsic floor and re-baseline the gate. **Do NOT bump shard mass blindly** — v1.5.1 shows the synth shard can actively destabilize; more of it is not obviously safe.
- **Ship v1.5.0 (87.4%) as v4.6.0, or hold v4.5.0?** It misses the 91 floor by 3.6pp but is +32.9pp over the shipped model on the hard golden. Operator's explicit call (re-baseline-and-ship vs hold). See "Ship decision" above.
- **`__isCompiledTree` off-by-one?** The gate-integrity fix bridged `core/out/data` locally; the deeper question (does repo.ts's compiled-tree detection resolve FALSE when it should be TRUE?) is load-bearing and deferred to daylight review (#481).

## Concrete next steps

- **Operator ship decision** on v1.5.0 (recommendation: hold + pursue a non-weight lever; alternative: re-baseline floor + ship the +32.9pp). v1.5.0 artifacts are staged at `artifacts/v1.5.0-fr-order/` on R2; v1.5.1 at `artifacts/v1.5.1-fr-order/` (rejected, kept for the record).
- **Pivot to Phase 3** (the forward schedule, `2026-06-13-FORWARD-SCHEDULE.md`): the parity table is effectively closed AND both coordinate-truth engines are now verified working (see "Bonus" above). The next centerpiece is the **mechanical resolver-API wiring** that surfaces the built interpolation (#483) + reverse-geocoding (#484) tiers — the cleanest, lowest-risk step to a real geocoder.
- **File the fr.house_number convergence finding** as a GitHub issue (weight falsified, plateau ~87%, postcode-fragmentation failure mode) so the next attempt starts from evidence.
- **prettier sweep #7b**: Sonnet limit resets 2026-06-14 9pm Paris.
- **corpus-v0.5.1 code-point re-align** (#558): DeepSeek's parallel track.

## Numbers

|                        |                                                                        |
| ---------------------- | ---------------------------------------------------------------------- |
| Wave-A tasks           | 3 delegated / 3 verified / 3 merged (#561, #562, #563)                 |
| Centerpiece            | 2 runs (v1.5.0 weight 3.0, v1.5.1 weight 6.0), both 40K steps, 0 NaN   |
| v1.5.0 fr.house_number | **87.4%** — best recovery (+32.9pp vs v4.5.0's 54.5%), misses 91 floor |
| v1.5.1 fr.house_number | **84.7%** — WORSE; weight falsified + postcode-fragmentation failure   |
| Bridge retirement      | HOLDS: us.po_box_real=90.3% (floor 89.1) ✅                            |
| German order           | HOLDS: de.native_locality=90.8% (floor 83.8) ✅                        |
| arena.perturb          | **78%** (was silently NOT FOUND; fixed + enforced, commit ab2a029) ✅  |
| Models trained         | 2 (both complete + gated)                                              |
| NaN incidents          | 0                                                                      |
| Gate-integrity bugs    | 1 found + fixed (arena.perturb un-evaluable)                           |
| Phase-3 de-risk        | #483 VT gate PASSES (ladder mode) + #484 reverse tests PASS (real DBs) |
| Task 5 (prettier)      | DONE by supplemental session (`cb2ea168`)                              |
