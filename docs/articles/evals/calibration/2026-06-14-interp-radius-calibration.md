# Calibrating the interpolation radius — honest confidence for the street-level tier

_2026-06-14. The forward geocoder's interpolation tier stamps an `uncertainty_m` radius = half the
matched TIGER segment's length. That's an honest geometric prior, but is it a calibrated confidence
bound? A split-conformal calibration on the Travis-County E-911 holdout says no — the raw radius is too
tight, covering only ~72% of true errors. Multiplying by Q̂ ≈ 1.70 makes it a real 90% bound. This
records the measurement and the opt-in wiring that ships it._

## Why this is the confidence half of the DoD

The definition of done is "street-level coordinate **with a calibrated confidence radius**." Coverage is
handled by the situs + interpolation cascade (national, as of 2026-06-14). Confidence is the radius the
geocoder reports. A radius is only meaningful if it's calibrated: if we say "±87 m" it should contain the
truth ~90% of the time, not 72%. Otherwise the number is decoration.

## The measurement

Split-conformal prediction (`scripts/eval/conformal-calibrate.ts`, #374) over the **interpolation tier
in isolation** — situs forced off (an empty-but-valid address-point db) so every resolved row falls
through to interpolation, on the full national TX interp shard (254 counties):

```
holdout  : Travis County E-911 (1965 rows)
resolved : 1562 interpolation hits (79.5% street-level hit rate)
abstained: 403 (no street-level coordinate → admin-centroid)
split    : cal=781  test=781

target coverage (α = 90%)
conformal threshold Q̂            : 1.7006   (× claimed_radius = calibrated 90% interval)
empirical coverage on test split : 91.5%    ✓ within 3pp of target
uncalibrated coverage (Q̂ = 1)    : 71.9%    ← the raw heuristic is too tight

per-tier (interpolated, n=1562):
  median error            52.7 m
  median claimed radius   87.0 m   (raw half-segment)
  median calibrated radius 148.0 m (× 1.70)
```

The half-segment heuristic **underestimates** the true spread by 1.70×. Reporting the raw radius would
tell a user "±87 m" when the honest 90% bound is ±148 m. (The situs tier is the opposite — its fixed 10 m
floor is conservative vs the ~1 m doorstep error we measure, which is safe; under-reporting confidence,
as interpolation did, is the dangerous direction.)

## What ships

An **opt-in, byte-stable** calibration multiplier — the resolver stays calibration-agnostic (the factor
is a property of the calibration set, not the geometry), and the caller supplies it:

- `ResolveOpts.interpolationRadiusCalibration?: number` — when set, `applyInterpolation` reports
  `uncertainty_m = round(raw × factor)` and preserves the raw value under `uncertainty_raw_m`. Absent =
  raw heuristic (byte-stable; the 40 resolver tests are unchanged).
- The **`geocode` CLI** passes the TX-derived **1.70** by default (`--interp-calibration`, pass `1` to
  report the raw radius). Verified: Concord NH 3 → 5 m, Honolulu HI 75 → 128 m; situs hits unaffected.

## Caveats / next

- **The 1.70 is TX-calibrated.** TIGER's segment methodology is uniform nationwide, so it's a sound first
  approximation, but the true Q̂ likely varies with road-network density (rural long segments vs urban
  grids). Re-calibrate on a multi-region holdout before treating 1.70 as national-exact — and consider a
  per-`interpolation_method` or per-segment-length-bucket Q̂ rather than one global scalar.
- **Make it a loadable artifact.** Today the factor is a CLI constant. The principled home is a
  calibration artifact (like the isotonic `conf=` calibrator, #59) the resolver/CLI loads — so re-calibration
  is a data swap, not a code change.
- **Abstention router (#244)** is the remaining confidence piece: when the calibrated radius exceeds a
  threshold, return the coarser admin tier instead of a falsely-precise street point. The 403 no-hit rows
  already abstain to admin; #244 generalizes that to a confidence-gated downgrade.

## Reproduce

```bash
sqlite3 /tmp/empty-situs.db "CREATE TABLE address_point (street_norm TEXT NOT NULL, street_key TEXT NOT NULL, number TEXT NOT NULL, unit TEXT, postcode TEXT, locality_norm TEXT, street_raw TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, source TEXT NOT NULL, release TEXT NOT NULL);"
node scripts/eval/conformal-calibrate.ts \
  --holdout /tmp/ood-truth.jsonl \
  --address-points /tmp/empty-situs.db \
  --interpolation $MAILWOMAN_DATA_ROOT/interpolation/interpolation-us-tx.db
```
