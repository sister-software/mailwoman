# 2026-07-02 → 03 — night 31 postmortem (IN PROGRESS — sketch updated through the shift)

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
