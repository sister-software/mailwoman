# Night 14 postmortem — the geocoder gets built, calibrated, and made callable

_2026-06-14. The night the street-level geocoder went from "proven on two regions" to nationwide
coverage, honest confidence, and a callable batch service — and the night an audit caught a
catastrophic regression that every eval had been blind to. Six PRs, two national data builds, zero
training runs. Operator handoff to Heather mid-shift; RemoteResolver is the in-flight next piece._

## What shipped

All six merged to `main`:

- **#566 — Retire joint-reconcile as the default decode path.** A reconcile-vs-raw-neural audit found
  the joint-reconcile path (#427's default) **breaks the street+house_number geocode precondition on
  77–84% of clean US addresses and fixes 0%** (golden US+FR per-tag: street −25.6pp, house_number
  −23.1pp, worse-or-flat on every tag including venue). The phrase grouper bundles the house number into
  the STREET_PHRASE and `reconcileSpans` fuses the span. Invisible because our evals grade **raw neural**,
  not the assembled pipeline. Flipped the default to argmax; filed the grouper root cause as #565.
- **#567 — National situs.** 124,928,159 address points, 50 states, 29 GB, 0 failures, from the pinned
  Overture parquet. Driver `build-national-situs.mjs`.
- **National interpolation** (shipped under the #569 arc, no separate PR — data artifacts). 52 shards,
  11 GB, all 3144 TIGER counties. Fills the situs-miss tail including NH + HI (zero Overture situs).
- **#569 — Conformal-calibrated interpolation radius.** The raw half-segment radius covers only 71.9% of
  true errors; **×Q̂=1.70 → 91.5%** (target 90%). Opt-in `ResolveOpts.interpolationRadiusCalibration`,
  on-by-default in the geocode CLI.
- **#570 — Empty-shard graceful degradation (#568).** A tableless shard crashed a whole state; now it's a
  no-op miss. Shared `hasTable()` guard across all three lookups.
- **#571 — Street-level `/api/geocode` + `/api/batch` (#485 pt 1).** Extracted the cascade into
  `geocode-core.ts` (shared by CLI + server), added batch with bounded concurrency + per-row error
  isolation + a per-state shard cache.
- **#572 — Observability `/health` + `/metrics` (#485 pt 2).** "What's deployed in one curl" +
  per-tier counts and latency percentiles.

## What went well

- **Audit-first discipline paid off enormously.** The reconcile regression was a ~weeks-old, catastrophic,
  eval-invisible bug. Running the precondition audit on real holdout truth — not trusting the green
  scorecards — is what surfaced it. The lesson is now load-bearing: grade the *assembled pipeline* against
  truth, never raw-neural per-tag F1.
- **Probe-before-implement corrected two plans.** The licensing probe (zero OSM in US Overture) killed the
  "filter to NAD" action item that would have dropped a third of coverage for no benefit. The DuckDB
  streaming probe + the parallel-driver probe defused the "national build is hours" fear (4.2 min).
- **The cascade extraction was clean.** Refactoring the validated CLI onto the shared core re-validated
  byte-for-byte (TX/CA 1m, NH 5m, HI 128m) — no regression, and now one implementation behind CLI + service.
- **Honest numbers throughout.** Named the situs-in-distribution caveat, the TX-only calibration caveat,
  the interp-only-vs-combined DoD split. Confidence radii are now truthful, not decorative.

## What could've gone better

- **The situs build OOM'd on first launch.** The single-state timing probe used DE (562K rows) — too
  small to surface the 4 GB heap blow on the 13M-row states (CA/FL/TX). Should have probed a *large* state
  first. Cost: one killed run + a streaming rewrite (which was the right fix anyway).
- **Self-inflicted crash.** A `sqlite3 <missing>.db "…"` diagnostic *created* empty db files that then
  crashed the geocode — I tripped my own wire. It became the #568 robustness fix, so net-positive, but the
  diagnostic should have used a read-only open.
- **Heat ran 92–93°C** during the concurrency-4 parallel build (operator-waived; AMD self-throttles ~95°C,
  no damage). Acceptable on a cold evening, but worth a thread/concurrency cap tuned to a heat budget.

## Decisions made autonomously

- **Retire reconcile rather than fix it (now).** Evidence was one-directional (worse on every tag); fixing
  the grouper is the real fix but it's multi-locale work (#565). Retiring the default is the free, sprint-
  aligned win. Alternative (fix-first) would have blocked the geocoder on a corpus/grouper change.
- **Build national situs UNFILTERED.** The zero-OSM probe overrode the campaign's "filter to NAD" plan.
  Alternative (NAD-only) would have dropped 39.4M points for no licensing benefit.
- **Full national interpolation (all 3144 counties), not top-N.** The rural tail counties are tiny
  (fast to fetch/build), so full ≈ top-N in cost but complete in coverage.
- **Observability before RemoteResolver**, against the issue's stated order. Rationale: the issue says
  "measure SLOs first" (needs the latency instrument) and `/health` is high-value/low-risk, whereas
  RemoteResolver is multi-instance machinery we don't need single-process.
- **interp calibration as a CLI-default constant (1.70), opt-in at the resolver.** Keeps the resolver
  calibration-agnostic + byte-stable; the caller owns the factor.

## Open questions (for the operator)

- **Multi-region recalibration of the 1.70 interp factor** — it's TX-only; Q̂ likely varies with road
  density. And promoting it to a **loadable artifact** (the #59 isotonic pattern) so recalibration is a
  data swap.
- **#244 abstention router** — confidence-gated downgrade to admin when the calibrated radius is too large.
  The remaining confidence piece.
- **The dev weights symlink points at v140** while the shipped model-card is v4.6.0/v150 — harmless for the
  geometric calibration, but the eval scripts should pin the shipped model.
- **Demo/npm**: none of tonight's work is published — it's all resolver/data/service code + local data
  artifacts. A release is a separate decision.

## Concrete next steps

1. **RemoteResolver adapter (#485 pt 3)** — IN FLIGHT. The `Resolver` interface over HTTP (stateless
   parser nodes + a resolver service; canary-vs-Pelias). The biggest architectural lift of the four.
2. **Versioned data switchover (#485 pt 4)** — atomic DB pointer-swap for zero-downtime updates.
3. **#565** — fix the phrase grouper's house-number bundling (unblocks re-enabling reconcile for FR/EU).
4. The deferred confidence items above.

## Numbers

| Metric | Value |
| --- | --- |
| PRs merged | 6 (#566, #567, #569, #570, #571, #572) |
| PRs open | 0 (RemoteResolver in flight) |
| National data builds | 2 — situs (124.9M pts, 29 GB), interpolation (52 shards, 11 GB) |
| Tests added | ~17 (reconcile audit ×2, empty-shard 3, geocode-router 5, health-router 4, + recorder units) |
| Issues filed | 3 (#565 grouper, #568 empty-shard→fixed, audit findings) |
| Modal GPU time | 0 (no training — resolver/data/service night) |
| NaN incidents | 0 |
| Heat peak | 92.8 °C (operator-waived) |
| Parallel situs build | 40 states in 4.2 min (concurrency 4) |
| DoD checkpoint | 98.8% within 100m (Travis, non-circular); interp-only 79.5% hit / 52.7m median |
