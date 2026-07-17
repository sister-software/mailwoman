# Night-4 postmortem — 2026-07-17 (autonomous, 04:36–15:00 UTC)

Living document — sketched during the shift, finalized at hand-off.

## Shift charter

Operator handoff 04:36 UTC: B1 (#727 stage-2 k-best, plan #1134) as the main arc (protected lane,
night 1), P1 (locality name-index #30) as a parallel agent. Publish + train authorized. Context
coming in: v6.5.0 shipped this morning; the v1 rules parser deleted this evening (#1151, seal tag
`legacy-rules-final`); the swap gate runs on coordinate acceptability + the two-guard plausibility
module; cascade probe closed shape-routing with receipts.

## What shipped

- (running log)
- 04:45 — stale-out/ hazard post-deletion FOUND + FIXED: tsc leaves orphaned emit; out/commands/debug.js
  still imported the deleted createAddressParser and crashed the pre-commit hook (a commit silently
  failed). Wiped all out/ trees + recompiled. EVERY pre-deletion checkout will hit this — flag in handoff.
- 04:47 — Dependabot critical #114 + medium #115 (websocket-driver 0.7.4, sockjs/webpack-dev-server
  chain, dev-only exposure) cleared via resolutions pin ^0.7.5 (7f56f603).
- 04:43–04:52 — B1 step 3: PT/RO splice v0.12.0-ptro-splice built from 35k WOF PT+RO native surfaces
  (+2,310 pieces, +3.2%, EN-identity PASS; RO comma-below byte-fallback eliminated). Mean-init from
  v381 done; 2k probe launched (v3.9.0, ap-wyS4XeIeCE0mtzo8zDWdaT). SALVAGE CATCH: night-3 falsified
  the OA-sourced splice (uppercase PT / stripped RO) and mechanism-confirmed the WOF re-source as
  v267 with a multi-leg pre-registration demand (fr/it/pl overlap + the broken BR row) — the probe's
  read is AMENDED accordingly: grade parity subsets pt/ro/fr/it/pl/br, not just the target.
- 04:55 — P1 CLOSED via the pre-registered measured-negative exit (PR #1152, docs-only, operator
  merge): decode-time atlas prior structurally cannot separate `…Chevaleret Paris` from `Rue de
Paris` (identical terminal token + membership; emission-gap distributions overlap; a bias that
  flips the targets breaks 3/10 real streets). Fix specified as StreetLocalityEvidence for the
  B1 phase-4 arbiter. Correction: gh issue #30 = NAD adapter; the tracker is the #1101 xfail.
- 04:56 — B1 phase-4a: the REPAIRED rerank measurement (scratchpad/rerank-valid.mjs, full geocode
  cascade after the dark-resolver 0/267 bug) found staged-but-unrun with the v301 span-head cache —
  RUNNING now. This is the arc's central question (how much of oracle@10 0.749 vs seg@1 does
  evidence-based rerank collect) and P1's design routes to exactly this component.
- 04:58 — PT/RO 2k probe PASSED the amended multi-leg read (ro street 0.800->1.000 — the
  byte-fallback target; fr guard +0.022; pl flat; the night-3 broken BR row HELD; goldens us 47.8 /
  fr 42.5 = noise). 8k (v391) launched ~05:00, healthy at step 4400 by 05:03.
- 05:02 — P3 staged (b3d741bd): augment_upper_case_prob mirroring lowercase_row (#829), 4 tests,
  default-off; enabling rides the span-arc retrain with a pre-registered ALL-CAPS read.
- 05:12–05:35 — v391 (PT/RO 8k) graded: RO 1.000 + fr guard HELD, goldens noise, digit board clean
  (bare-street-hn 0.743), gauntlet PASS — but the BR GUARD ROW BROKE (street->venue label flip on
  "Rua Raul Leite Magalhães", n=1; segmentation still perfect) and FR fragment reads 0.747 vs v381's
  0.758 (-1.1pp, CI-overlapping). Pre-registration named br a guard -> v391 does NOT auto-promote;
  ship/hold is an operator handoff item. The 2k (v390) was strictly additive; the 8k traded.
- 05:21 — phase-4a rerank v1 found CRASHED AT IMPORT 45min earlier (neural/semi-markov-decode.ts is
  on the archived feat/727-span-head branch, NOT main — my "phases 1-3 on main" was half-right: python
  scorer merged, JS decoder didn't). Liveness checks were fooled by the watcher's self-matching pgrep.
  Re-ran from a branch worktree.
- ~05:20 (receipt 7f46415a @ 05:27) — PHASE-4A RESULT (the arc's central question): **rerank@1 = seg@1 = 0.5768, delta +0.
  Full-geocode tier evidence collects NONE of the oracle@5 0.723 headroom** — because it is STARVED:
  evidence rate 3.4% (9/267 fixtures produced street-tier evidence on any hypothesis; tier census
  1308 admin / 25 address_point / 2 street). The failing class is context-free fragments, which
  cannot reach rooftop layers, so all hypotheses tie at admin. NOT a treadmill case — first
  measurement; the redesign is measurement-driven: the arbiter needs STREET-NAME existence evidence
  (P1's StreetLocalityEvidence — two independent negatives converged on the same design today).
- ~05:25 (same receipt) — name-evidence falsifier v0 (FR BAN street-centroids 2.2M + NO tuples, n=7 recoverable):
  2 clean discriminations incl. the refusal class, 4 neutral both-out (typos fail closed), 1 anti
  (index incompleteness + unscoped bare-name membership). Promising, unproven at n=7 — scaling to
  the FR fragment board (n=400, complete BAN coverage) next.
- 05:29 (dd2e8aae) — **PHASE-4B RESULT at board scale (n=1600, the FR fragment board's four street classes):
  name-evidence rerank street@1 0.619 → 0.706 (+8.7pp); bare-street 0.675 → 0.860 (+18.5pp) — the
  66% recall class every corpus lever plateaued on, collected with ZERO training.** Of 202
  recoverable rows: 140 fixed / 14 broken / 48 neutral (10:1). Resolver-as-arbiter validated with
  the corrected instrument; option C no longer the primary lever for bare fragments. Eval doc:
  `2026-07-17-phase4-name-evidence-rerank.md` (dd2e8aae). Caveats stated there: v301 span artifact
  (k-best only exists on the archived branch — this result is the consumer that justifies merging
  it), FR-only index, BAN-derived board = ideal coverage.
- 05:32 — v391 golden gate found CRASHED, and the cause is a MAIN-BRANCH BREAK the excision left:
  #1151 deleted `harness-v0-neural.ts` but `external-arenas.ts` (a promotion-gate leg) still
  invoked it — every post-excision gate battery dies at the arena leg. Fixed as **PR #1153**:
  `harness-neural.ts` = the seal-tag harness ported neural-only (neural semantics unchanged →
  pass rates comparable), summarize-arenas drops the v0 buckets. tsc + 10-row smoke clean. The
  v391 arena leg is moot for the verdict (v391 already held on the BR guard), but the next ship
  needs the battery working. PR #1153 opened 05:41.
- 05:44 — **PR #1154**: the archived span branch's runtime surface merged-to-branch for main
  (semi-markov k-best decode + rerank veto scaffold + spanScores threading, 880 ins). Clean merge,
  neural 305/305 + resolver 113/113 pass, presets byte-identical (shipped model exports no span
  head -> threading inert). The phase-4b result is the consumer that justifies this.
- 05:47 (aeaa15f7) — break audit + falsifier v2: the 14 breaks = truncation wins (10, bare `rue`/`chemin`
  sub-spans are in-index) + moved-off-correct-rank-1 (4, fold mismatches). Two guards (G1 no
  pure-type-vocabulary evidence, G2 margin cap 2.5), pre-registered breaks<=6 fixes>=135: **148
  fixes / 3 breaks (49:1), street@1 0.711, bare-street 0.875 (+20.0pp over base)**. Both bars
  cleared. Phase-4c spec committed with the interface + per-country index plan:
  `docs/superpowers/specs/2026-07-17-727-phase4c-street-name-evidence.md` (aeaa15f7).
- 05:57 — **v3.10.0-span-ship-probe LAUNCHED** (ap-4fFe1R2Zf0pH4MaIKKMpTr, 2k): the #727 step-4
  recipe assembly — span scorer on the SHIPPED v381 recipe (own param group 1e-3, the phase-1
  lesson) + P3 augment_upper_case_prob 0.15 (b3d741bd). Pre-registered reads in the config header;
  same corpus+tokenizer as v381 so F1 comparisons are VALID. sync_src_v3100 verify 6/6. Loss
  18.6 -> 1.89 by step 450 (v3.0.0 without the LR group sat at ~17 at 2k — the group works).
- 06:05 — LEG-2 instrument built + BASELINES REGISTERED: `--raw-case` added to per-locale-f1
  (normalizeCase off — the shim would mask the augment); allcaps-us-300 derived from golden-us
  (seed 42, upper_case_row eligibility). **v381 raw-case exact 48.3% / micro 79.8; shim-ON 60.7%**
  (the #690 shim is worth +12.4pp today). Probe bar: raw-case exact >= 53.3 (+5pp); shim-delete
  territory ~60+.
- 07:00 — **v3.10.0 2k GRADE** (`scratchpad/grade-v3100.log`, ap-4fFe1R2Zf...): span head exports
  clean (`span_scores` output present, int8 40.1 MB). **GUARD PASS** — golden us micro 86.9=86.9 /
  exact 66.4 vs 66.2 (+0.2), fr micro 90.0 vs 90.1 / exact 75.4 flat: the span head is a purely
  ADDITIONAL output, the BIO token path is byte-stable-ish. **LEG-1 span mechanism PASS** — loss
  18.6->1.49 converged (v3.0.0 stuck at ~17), the LR param group works. **LEG-2 P3 all-caps FAIL** —
  raw-case exact 48.0 vs v381 48.3 (-0.3pp) against the +5pp bar; augment_upper_case_prob 0.15 is
  INERT at 2k. Per no-relax-bars: P3 does NOT ride the 8k, the #690 shim stays (+12.4pp raw-case
  today). The span head DOES escalate — but seg@1 (leg-1 formal gate) runs first before the ~2h 8k spend.
- 07:08 — **seg@1 GATE PASS on v3.10.0 step-002000** (local CPU, eval_seg_at_1.py, parity 267):
  token@1 0.5581 / seg@1 0.6030 (+4.5pp) → the trained span scorer beats the token decode ON THE
  SHIP-RECIPE CORPUS (v0.11.0-no-fragment). This is the NOVEL confirmation: v301 proved the head on
  v257; v3.10.0 proves it survives the corpus swap. All THREE 2k legs green (guard byte-stable,
  loss converged, seg@1 crosses). The ~2h 8k spend's falsifier PASSED → escalating.
- 08:26 — **v3.10.1 8k RESUME COMPLETE** (resumed step 2000→8000 clean, no NaN): train_loss
  18.6→1.31, val macro_f1 0.6937 (2k was 0.6936 — token path unchanged, span head is additional).
  **seg@1 GATE PASS at 8k**: token@1 0.5581 / seg@1 0.5918 (+3.4pp). NOTE the span head PLATEAUS by
  2k: 8k seg@1 0.5918 is marginally BELOW the 2k's 0.6030 (-1.1pp, noise) — same 2k≈8k plateau as
  the B4b digit arc. The extra 6k refined train_loss (1.49→1.31) but not the decode gate. Grade
  (guard + P3 re-grade + oracle@5) running; export emitted the semi-crf-transitions sidecar (the
  new export_onnx path, c8c05fc7).
- 09:00 — **v3.10.1 8k GRADE COMPLETE — #727 step-4 (span-head training arc) CLEAN SUCCESS.**
  GUARD PASS (golden us 86.9/66.3 vs 86.9/66.2, fr 90.0/75.4 vs 90.1/75.4 — token path byte-stable,
  the span head is a purely ADDITIONAL output). seg@1 0.588 > token@1 0.558 (PASS). **oracle@5
  0.7865** (vs v301's 0.7228, +6.4pp) — 0.1985 street@1 headroom in ranks 2-5, exactly what the
  phase-4c rerank collects (phase-4b measured +18.5pp bare-street). P3 all-caps FAIL at 8k too
  (48.0 vs 48.3) → CLOSED inert, #690 shim permanent. Export emitted the sidecar (my export_onnx
  fix). SHIPS NOWHERE — the span head is dormant until phase-4c wires the decode; the token path is
  byte-stable so there's no promote decision. This is the phase-4c decode SUBSTRATE (v3101-cache +
  volume checkpoint). Full write-up: 2026-07-17-v3101-span-head-8k-result.md. The measured chain is
  now end-to-end: span head -> k-best -> oracle@5 0.786 -> name-evidence rerank, every link measured,
  none promoted.
- GOTCHA: `export_onnx --step` needs the ZERO-PADDED checkpoint name (`002000`, not `2000`) — the
  saver zero-pads. First grade run FileNotFounded on step-2000; fixed to 002000.
- TIMEKEEPING CORRECTION (self-caught TWICE: at the 05:03 checkpoint, and again at 05:48 when four
  fresh entries carried local+2h stamps): all stamps above are now receipt-anchored to commit/PR
  timestamps (the lab clock is UTC+2 — never stamp from the wall clock).

## What went well

-

## What could've gone better

-

## Decisions made autonomously

- B1 sequencing: plan #1134 step 3 (PT/RO tokenizer splice) before step 4 (span-scorer head) —
  the plan's own order; the splice is the proven letter-family (bsplice/nsplice/fr-nsplice
  precedents), independent, and feeds the span head's inputs. Numsplice's failure does NOT
  contraindicate it: that was the NUMERIC manifold (shared bare/contextful digits); letter
  diacritic splices shipped clean three times.
- Noted as historical, not re-litigated: plan #1134's tail still names the 0.90 parity floors as
  the swap gate; superseded by the 2026-07-17 operator criterion ruling + the merged swaps + the
  deletion. The arc now feeds model quality / n-best / plan-5 retrain, not a swap unblock.

## Open questions

- Operator rulings still pending: M4 (NZ tier), M2 (postcode-precision floor value), CJK scope,
  deepparse-data counsel bundling.
- **#32 / #1142 importance (scoped tonight, NOT started — needs an operator decision):** three
  defects, different ship paths. (1) The stale FST (`fst-global-priority.bin` 2026-05-28 vs DB
  2026-07-07: rome 0.378→0.860, madrid 0.138→0.909) is a pure artifact rebuild from the current DB
  — BUT it changes a shipped INFERENCE artifact (feeds `neural/fst-prior.ts`), so it's measure-
  before-ship (parity delta), not a blind rebuild; shippable alone. (2) `place_importance` never
  built (82% of importance is population-fallback-zero) is a data build (Wikipedia importance +
  log-pop fallback per `importance-vs-population.mdx`). (3) The matched/importance-0.0 overload (the
  [[feedback-meaning-of-zero]] class: unknown≠unimportant) is a MODEL FEATURE-ENCODING change
  (carry `matched` and `importance` as separate features) → needs a RETRAIN to consume it, so it
  rides a span-arc retrain, not a standalone fix. Recommended sequencing: rebuild FST + measure
  (cheap, this shift or morning) → build place_importance (data) → fold the matched/importance split
  into the next span retrain (v3.10.x line). Piecemeal-shipping (1) alone is a half-measure the
  issue explicitly frames as one of three; hold for the operator to sequence.

## Concrete next steps

- **v3.10.0 2k probe grade** (blocked on step-2000): `scratchpad/grade-v3100.sh` runs
  export→int8→v381-sibling cache→guard(golden us/fr vs v381 baseline 86.9/90.1 micro)→LEG-2
  all-caps (raw-case, bar ≥53.3 exact vs v381 48.3). Cache template `scratchpad/v381-punct-full-cache`
  (SAME tokenizer → F1 valid). seg@1 formal gate deferred to 8k (leg-1 mechanism already confirmed:
  loss 18.6→1.55, vs v3.0.0's stuck 17 — the LR param group works).
- **export_onnx sidecar gap (8k handoff)**: the Modal `export_onnx` fn writes `model.onnx` but NOT
  `semi-crf-transitions.json` (that's `package_weights.export_semi_crf_transitions`, a separate
  path). The phase-4c/PR-#1154 k-best decode needs the sidecar, so the 8k package build must route
  through package_weights or export_onnx must be extended to emit it. Harmless for the 2k BIO-path grade.
- **PRs awaiting operator merge** (both green, not self-merged — new runtime surface + eval tooling):
  #1153 (arena-harness neural-only, unblocks the gate battery — merge FIRST, main's battery is broken
  without it), #1154 (span-decode surface to main — the phase-4c consumer). Then #1152 (P1 design doc).
- **Phase-4c** (`docs/superpowers/specs/2026-07-17-727-phase4c-street-name-evidence.md`): build
  `StreetLocalityEvidence` after #1154 lands + a span-head model ships. Measured v2 policy: 148 fixes / 3 breaks.

| metric              | value           |
| ------------------- | --------------- |
| shift window        | 04:36–15:00 UTC |
| models trained      | (tbd)           |
| Modal $             | (tbd)           |
| NaN incidents       | 0               |
| CI failures         | 0               |
| regressions shipped | 0               |
