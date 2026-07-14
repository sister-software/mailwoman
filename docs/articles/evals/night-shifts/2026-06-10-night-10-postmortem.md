# Night-10 postmortem — 2026-06-10 (the flag-plant shift)

Autonomous shift, 08:08–15:00 UTC equivalent (operator offline, extended-trust delegation).
Plan: `2026-06-10-NIGHT-SHIFT-PLAN.md`. Headline mandate: ship Run B as v4.2.0 iff the ship
gate passes; merge the flag-plant set; then eat the queue. All three happened; the queue is
substantially eaten.

## What shipped

- **v4.2.0 — the v1.0 parity flag-plant — live on every surface, byte-verified — and in true ship config it beats v0 on the CLEAN arena (41 vs 29), the first time ever.** Ship gate
  4/4 (`2026-06-10-night-10-ship-gate.md`): honest-eval VT identical to baseline, presets
  clean (+ the intended affix split), int8 ≤0.1pp of fp32 (deterministic quant, md5
  `9eb4a99f…`), DE native 90.9. Merge sequence #468 → #469 → #491 (epic #466 closed), zero
  conflicts (the operator's squash choreography worked exactly as designed), zero
  merge-wall blocks. Bookkeeping #494 (cards w/ honest `init_from` lineage, ledger row,
  scorecard re-emit, status/releases contract pages). HF staged + default; **the R2 leg**
  (10 objects, served-model md5 = the gated artifact); `publish.yml` → npm 4.2.0
  (registry-direct verified), tag + release object.
- **promotion-gate.sh (#479, closed via #495):** gate-specs-as-contracts; validated by
  reproducing the manual ship verdict bit-for-bit (12/12 floors, max int8 delta 0.1pp).
- **US source-independent holdout (#472, closed via #496):** 6,453 NAD-only rows, 44
  states. **No memorization cliff** — v4.2.0 within noise of v4.1.0 on never-seen-lineage
  data; the consolidation's gains are real.
- **Address-point tier (#476, closed via #497):** VT prototype. **Coord p50/p90 3.4/7.4 km
  → 0.0/0.0 km, p99 277 → 6.2 km, 93.1% hit rate**; admin attribution untouched by
  construction. The 6.9% misses are #483's interpolation population; the shard is its gold.
- **postal_city alias table (#475 asset, via #499):** built (19,880 pairs, 51.3%
  divergent) — and its measurement REFUTED my own published attribution (below).
- **Parser hardening part 1 (#481, via #500):** one `#decode` (a third drift surface had
  already grown), repairs-in-both recorded, +2 policy sharp-case tests, loud lexicon
  validation. Scorer numbers reproduced exactly post-extraction.
- **Docs/infra:** RELEASING.md R2-leg correction (#501); REPRODUCIBILITY.md + the pinned-
  toolchain verifier (#480 safe parts); stale worktrees removed.
- **Issues filed from findings:** #492 (architecture escalation, evidence-backed, cheap-
  probe-first), #493 (lossless decomposition spec), #498 (census-designation name-credit —
  54% of NAD locality misses, the #386 class US edition). Design notes posted on #478
  (config surface, routing overlay, pre-registered v0-only→0 metric) and #487 (format-gap
  audit + TIGER-EDGES recipe + gate draft).

## What went well

- **The gate stack carried the night.** Pre-registered ship gate → binary verdict → no 3am
  judgment calls. The promotion-gate runner then reproduced the verdict mechanically — the
  night validated its own tooling on its own decision.
- **Probe-first kept paying.** The fill-rate probe's heir (the alias-table join) killed a
  wrong attribution in 20 minutes; the smoke test surfaced Barre City ≠ Barre Town before
  it became a wrong-answer class.
- **Background CI watchers + interleaving:** seven PRs merged with zero idle waiting;
  every wait window held a reservoir item.

## What could've gone better

- **I published a wrong finding and corrected it hours later.** The NAD note's Finding 2
  attributed the locality gap to vanity cities; the measurement said census designations
  (1/461 vs 54%). Correction block published same-night, #498 filed with the real numbers.
  Lesson: classify the misses BEFORE naming the cause — the attribution was plausible,
  available, and wrong.
- **The arena harness graded the wrong model silently** (env vars, not flags; the
  identical-to-baseline numbers were the tell). Caught before publication; the env-var
  interface is a footgun worth a flags PR.
- **The release pipeline had an undocumented mandatory leg** (R2). Cost ~20 minutes of
  cache-vs-origin diagnosis mid-release; now documented with verification commands.
- **My benchmark hygiene:** the byte-stability stash-check for #500 compared the same
  compiled tree twice (worthless); replaced with scorer re-runs against known numbers.

## Decisions made autonomously (alternatives considered)

1. **Ran honest-eval with zero-filled gaz clues** (harness lacks the flag) — accepted as
   conservative-valid since it PASSED degraded; alternative was harness surgery mid-gate
   (rejected: gate integrity over completeness).
2. **Repairs-in-both for `parseWithLogits`** — reconcile must see user-path tokens; the
   opts were silently ignored before, so no default change. Alternative (document the skip)
   rejected as preserving a latent divergence.
3. **Arena dip (−2/3pp whole-parse) reported with caveats, NOT treated as a gate** — the
   arenas were never pre-registered as ship criteria; adding one retroactively is gate
   drift in the other direction. Flagged for morning eyes instead.
4. **#487 eval build deferred** (census downloads + shapefile parsing at hour 7) — recipe
   posted instead; risk-ordering guardrail applied.
5. **#475 consumption deferred** after the measurement showed the NAD eval can't see the
   vanity-city mode — the claim waits for an eval whose inputs carry postal surfaces.

## Open questions for the operator

1. ~~The arena whole-parse dip~~ **RESOLVED before shift end:** gaz/anchor support added
   to the arena harness; in TRUE ship config v4.2.0 scores **41/71/18** vs v4.1.0's 22/62/11
   and v0's 29/39/26 — every prior anchor-era arena number was handicapped, the "dip" was
   the harness, and **v4.2.0 beats v0 on the clean arena for the first time.** Scorecard
   updated with the correction block.
2. **#397**: close as resolved-by-process, or re-title to the test-restores-symlink ask?
3. **#492 architecture escalation**: the cheap probe (dedicated affix head) is specced and
   gated — fund it when?
4. The night-9 → night-10 arc (silent gate drift caught → canonical bars restored → stated
   re-baseline shipped) is a strong research blog story; draft deliberately not written tonight —
   want it?

## Concrete next steps

- Queue head (epic #488): **#478 implementation** (config surface first — design reviewed
  on-issue), then #498 (designation credit, NJ bellwether), #481 part 2 (TLA, repo.ts),
  #487 eval build (recipe on-issue), #483 interpolation (gold standard now exists).
- #480 remaining: loader strict-mode, curriculum stamping, snapshot publishing.
- Eval follow-ups: gaz-fed arena harness; a postal-surface eval for #475.

## Numbers

|                                   |                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| shift span                        | 08:08–15:00 UTC (operator offline)                                                                                     |
| models trained                    | **0** (treadmill guard held; 1 export + 2 quant runs, ~3 min A100)                                                     |
| released                          | v4.2.0: npm (13 pkgs, registry-verified), HF + R2 (md5-verified), tag, release object                                  |
| PRs merged                        | 10 — #491, #494, #495, #496, #497, #499, #500, #501, #502, #503 (gaz-fed arenas)                                       |
| issues closed                     | #466, #472, #476, #479 (+ #475/#481/#487/#478 advanced with scoped completions)                                        |
| issues filed                      | #492, #493, #498                                                                                                       |
| evals run                         | ship gate ×2 artifacts, arenas ×2 (one invalid, caught), NAD holdout ×2 models, VT tier on/off, gate-runner validation |
| findings corrected by measurement | 3 (NAD Finding 2; the stash byte-check; the arena 'dip' — handicapped harness, resolved to a +19/+9/+7 sweep)          |
| CI failures                       | 1 (MDX raw-angle, fixed in 8 min)                                                                                      |
| merge-wall blocks                 | 0                                                                                                                      |
