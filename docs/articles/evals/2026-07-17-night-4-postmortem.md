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
- 05:45 — PHASE-4A RESULT (the arc's central question): **rerank@1 = seg@1 = 0.5768, delta +0.
  Full-geocode tier evidence collects NONE of the oracle@5 0.723 headroom** — because it is STARVED:
  evidence rate 3.4% (9/267 fixtures produced street-tier evidence on any hypothesis; tier census
  1308 admin / 25 address_point / 2 street). The failing class is context-free fragments, which
  cannot reach rooftop layers, so all hypotheses tie at admin. NOT a treadmill case — first
  measurement; the redesign is measurement-driven: the arbiter needs STREET-NAME existence evidence
  (P1's StreetLocalityEvidence — two independent negatives converged on the same design today).
- 05:50 — name-evidence falsifier v0 (FR BAN street-centroids 2.2M + NO tuples, n=7 recoverable):
  2 clean discriminations incl. the refusal class, 4 neutral both-out (typos fail closed), 1 anti
  (index incompleteness + unscoped bare-name membership). Promising, unproven at n=7 — scaling to
  the FR fragment board (n=400, complete BAN coverage) next.
- 06:00 — **PHASE-4B RESULT at board scale (n=1600, the FR fragment board's four street classes):
  name-evidence rerank street@1 0.619 → 0.706 (+8.7pp); bare-street 0.675 → 0.860 (+18.5pp) — the
  66% recall class every corpus lever plateaued on, collected with ZERO training.** Of 202
  recoverable rows: 140 fixed / 14 broken / 48 neutral (10:1). Resolver-as-arbiter validated with
  the corrected instrument; option C no longer the primary lever for bare fragments. Eval doc:
  `2026-07-17-phase4-name-evidence-rerank.md` (dd2e8aae). Caveats stated there: v301 span artifact
  (k-best only exists on the archived branch — this result is the consumer that justifies merging
  it), FR-only index, BAN-derived board = ideal coverage.
- 06:20 — break audit + falsifier v2: the 14 breaks = truncation wins (10, bare `rue`/`chemin`
  sub-spans are in-index) + moved-off-correct-rank-1 (4, fold mismatches). Two guards (G1 no
  pure-type-vocabulary evidence, G2 margin cap 2.5), pre-registered breaks<=6 fixes>=135: **148
  fixes / 3 breaks (49:1), street@1 0.711, bare-street 0.875 (+20.0pp over base)**. Both bars
  cleared. Phase-4c spec committed with the interface + per-country index plan:
  `docs/superpowers/specs/2026-07-17-727-phase4c-street-name-evidence.md` (aeaa15f7).
- 06:45 — **PR #1154**: the archived span branch's runtime surface merged-to-branch for main
  (semi-markov k-best decode + rerank veto scaffold + spanScores threading, 880 ins). Clean merge,
  neural 305/305 + resolver 113/113 pass, presets byte-identical (shipped model exports no span
  head -> threading inert). The phase-4b result is the consumer that justifies this.
- 06:10 — v391 golden gate found CRASHED, and the cause is a MAIN-BRANCH BREAK the excision left:
  #1151 deleted `harness-v0-neural.ts` but `external-arenas.ts` (a promotion-gate leg) still
  invoked it — every post-excision gate battery dies at the arena leg. Fixed as **PR #1153**:
  `harness-neural.ts` = the seal-tag harness ported neural-only (neural semantics unchanged →
  pass rates comparable), summarize-arenas drops the v0 buckets. tsc + 10-row smoke clean. The
  v391 arena leg is moot for the verdict (v391 already held on the BR guard), but the next ship
  needs the battery working.
- TIMEKEEPING CORRECTION (self-caught at the 05:03 checkpoint): the log lines above originally
  carried local-time-derived guesses labeled as UTC; fixed to actual UTC. Everything above happened
  in the first ~27 minutes of the shift.

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

## Concrete next steps

-

| metric              | value           |
| ------------------- | --------------- |
| shift window        | 04:36–15:00 UTC |
| models trained      | (tbd)           |
| Modal $             | (tbd)           |
| NaN incidents       | 0               |
| CI failures         | 0               |
| regressions shipped | 0               |
