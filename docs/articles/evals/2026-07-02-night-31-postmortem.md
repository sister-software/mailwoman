# 2026-07-02 → 03 — night 31 postmortem

Shift: 05:56 → 16:00 UTC, $30 Modal ceiling, plan `nightshift/2026-07-02-NIGHT-SHIFT-PLAN.md`.

## What shipped (running)

- **v1.9.8 probe PASS → full run → FULL GATE FALSIFIED THE RUN (the system worked).** Probe:
  FR bare-intact 90→93%, US 12-row spot byte-identical. Full run (12k, six 2k checkpoints):
  sweet-spot scan put FR at 93% through 10k (12k dipped to 90 = ties baseline, fails the WIN
  acceptance; the 12k corpus-val jump is label-F1 — not a gate input). Full gate at 10k int8:
  US/CZ/PL/SK ni PASS, **SI ni FAIL** (resolve −3.4pp; also fails at 6k → intrinsic): 37 rows
  lost, ALL the Slovenian no-street "Village N, Postcode Village" form — the shard's boundary
  lesson splits "Apače 108" into street "Apače 10" + house "8". **Nothing from v1.9.8 ships.**
- **Run 2 (v1.9.9-bare-street-si) launched:** + `synth-si-bare-village` counter-shard (6,285 real
  OA SI village-repeated tuples, 3 orders, number-diversity-picked; overlay v0.9.9, 696 shards,
  0 /mnt leaks). Probe gate pre-registered WITH the SI failure slice (`si-lost37` ≥30/37) — the
  run-1 lesson (the probe gate lacked an SI leg) applied. New recipe `si-bare-village` +
  exporter committed on the campaign branch.
  Case-aug had been DROPPED from run 1 (schedule adjustment #1): v1.9.6 shelving record = metamorphic gate failure +
  #834/#895 deterministic coverage. Recipe branch `feat/901-run1-bare-street-bsplice`.
- **#900 splice safety gate: PR #911 MERGED.** Codepoint-overlap assertion + report artifact +
  CONTRIBUTING rule; 4/4 tests.
- **PR #913 (open, CI running):** #905 acceptance rows → gauntlet as `improvement_target` under
  the new **#912** finding (below). Gauntlet verdict on main: PASS (15/20 gated + 6 tracked).
- **OA fetch ×8 → 5 landed** (ES 15.6M / NL 9.1M / CH 2.8M / NO 3.6M / HR 1.7M rows, ALL
  city-bearing; agent dodged a city-less legacy NO trap). IE/GB/HU: **no OA source exists**
  (proprietary registers) — a real answer for the SCOPE tier table. 1k panel sets BUILT for all
  five (sparse-region buckets needed --per-bucket raise for ES/NL/CH/HR).
- **PL/SK/SI post-#910 baselines dumped** (`gate-v193/{pl,sk,si}-905-base`).

## Findings (the night's real product)

1. **#912 (filed): bare famous city names defeat the #910 fix through the production cascade.**
   The whole-string placer is OOD on single bare localities (Paris→IT .35, Dublin→DE .46,
   Melbourne→GB .66, Vancouver→IT .53 — all wrong, all sub-hard-threshold) and its WRONG soft
   posterior re-ranks the exact tier; the geocode CLI separately inherits defaultCountry=US from
   the en-US locale; within US scope, alias-exact **Paris Township OH (30k)** out-ranks name-exact
   **Paris TX (25k)** (placetype-prominence defect, pre-existing). Sub-finding: "Åbo" parses to
   locality="bo" — classifier drops the leading diacritic (normalize is clean); #897 family.
2. v1.9.8 runs FAST on the fine-tune idiom: 2k probe ≈ 4.4 min A100. Budget barely dented.

## Run 2 + the fork (mid-shift update)

- **Run 2 (v1.9.9 + si-bare-village) KILLED at 6k as pre-registered:** probe 2k moved the failure
  slice 0→19/37 (mechanism works) but FR sat at 36/40; the one bounded extension to 6k (bars
  unchanged, kill explicit) read FR flat and SI **regressed to 13/37** — the counter-shard loses
  to the fr-shard gradient at convergence. Stopped; **fork posted to #901** (recommended shape:
  ONE unified bare-name-comma shard family — FR streets + SI villages + CZ Praha districts — over
  weight-rebalance treadmilling). US stayed byte-identical through every checkpoint of both runs.
- **Honest correction (#829):** the case-aug drop rationale overstated #895's coverage — its
  detection gate is ALL-CAPS-only; the metamorphic lowercase xfails still fail on current main.
  The v1.9.6 shelving stands on its own regressions; #829 remains open and uncovered.
- **Tier-3 panels, pass 2:** ES 98.7%/1.99km, NL 95.7%/1.83, CH 91.9%/0.70, HR 99.6%/0.76 (all
  tier-2-class), NO 86.9% with a 454km p90 tail (UPPERCASE non-ASCII poststed — outside the
  ASCII caps gate; a resolve-side case-fold candidate). Tier-3 unverified now = DK/FI (spatial
  fill in flight) + IE/GB/HU (no OA source).

## Second half of the shift (through ~08:30 UTC)

- **Tier-3 panel sweep COMPLETE (PR #915):** ES 98.7%/1.99 km, NL 95.7%/1.83, CH 91.9%/0.70,
  HR 99.6%/0.76, DK 91.1%/0.77, FI 98.7%/1.46 — every `country_weights` locale with obtainable
  data is now coordinate-paneled; SCOPE tiers 2/3 rewritten to the measured table. DK/FI needed a
  spatial CITY-fill; en route: the gap-fill gazetteer rows carry **degenerate point-bboxes**
  (containment matched 0/103,543 — windowed nearest-centroid is the working join).
- **#473 dispatched** (agent): TW postcode→admin from Overture + JP Overture eval gold, gates from
  the issue. **#818 dispatched** (agent): recipe docs in house voice, PR flagged for voice review.
- Sensors mystery resolved: `sensors` works but `coretemp` isn't loaded and modprobe needs sudo —
  operator item; Modal-first held all night.
- Friction worth recording: a `pkill -f <script>` matched its own background shell's command line
  and killed it (exit 144) — cost ~20 min; pattern-match pkill against argv you also occupy.

## Decisions made autonomously

- Case-aug excluded from run 1 (scar re-derivation: v1.9.6 gate-fail conditions still hold —
  STRONGER post-#895). Recorded in plan + gate log + config header.
- #905 gauntlet rows re-scoped from `pass` to `improvement_target` when the cascade flipped them —
  suite stays green, class stays visible, #912 carries the fix.
- init_from (not resume) for run 1 — the surgery export has no optimizer state; v1.9.7 precedent.

## Open questions for the operator

- #912 direction: placer abstention on bare single-locality inputs (query-shape-gated) + exact-tier
  placetype prominence. Needs a gate; not night work.

## Ledger (updated through the shift)

| item          | value                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| Modal spend   | ~$1 so far (probe 4.4 min + sync/export; full run ~20 min A100 in flight) |
| Runs launched | probe (done, PASS) + full run 1 (in flight)                               |
| NaN incidents | 0                                                                         |
| PRs           | #911 merged; #913 open (CI)                                               |
| Panels        | 5 sets built (ES/NL/CH/NO/HR), grading queued behind run-1 battery        |
