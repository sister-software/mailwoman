# The interpolation radius factor is regional — 1.70 is a Texas artifact

_2026-06-14. The conformal interpolation-radius factor (Q̂ = 1.70, #569) was calibrated on one region
(Texas / Travis County E-911). This re-gates it on four more states spanning the density spectrum,
using each state's situs address points (OA/NAD) as independent ground truth for the TIGER
interpolation tier — a non-circular holdout available for all 50 states. The factor is **not**
region-invariant: it runs 1.53× (dense NY) to 2.85× (rural MT), a ~2× spread that tracks rurality. The
shipped single 1.70× is overconfident in rural America and over-conservative in dense cities. The
parked "per-region vs single-factor" decision resolves toward **per-region**; this records the
evidence, ships a seed calibration table + reusable tooling, and flags the wiring decision._

## Why a second look

#569 turned the heuristic interp radius (half the matched TIGER segment length) into a conformally
calibrated 90%-coverage interval: multiply the claimed radius by Q̂ = 1.70 and you cover 90% of
held-out error. But that Q̂ came from a single region. A confidence interval calibrated on Austin and
shipped nationwide is only honest if the factor generalizes — and there's a physical reason to doubt it
does: TIGER segment geometry and address-point spacing differ between Manhattan and rural Montana, so
the _ratio_ of true error to segment length (what Q̂ captures) may differ too.

## Method — non-circular, by construction

For each state: synthesize a `{input, lat, lon}` holdout from the state's **situs** shard (OA/NAD
address points — the ground-truth coordinates), then run `conformal-calibrate.ts` **interp-only** (the
situs tier no-op'd via the #568 tableless guard) so every resolved row is a TIGER **interpolation**,
scored against the true situs coordinate. TIGER (Census street ranges) and OA/NAD (address points) are
independent sources, so this is non-circular — the same provenance separation the Texas/Travis
calibration relied on, now available 50× over from the national situs build. n ≈ 1500 interp hits per
state, 50/50 cal/test split, α = 0.90.

## Result

| state | character      |  interp Q̂ (90%) | coverage @ Q̂ | uncalibrated (Q̂=1) | median err | median claimed r |
| ----- | -------------- | --------------: | -----------: | -----------------: | ---------: | ---------------: |
| NY    | dense urban    |        **1.53** |        90.6% |              79.7% |     45.2 m |            104 m |
| TX    | urban (Travis) | **1.70** [#569] |            — |                  — |          — |                — |
| CA    | large / varied |        **1.87** |        91.0% |              76.1% |     40.6 m |             82 m |
| MI    | mid            |        **1.93** |        89.7% |              77.1% |     51.1 m |            113 m |
| MT    | extreme rural  |        **2.85** |        90.2% |              62.7% |     61.3 m |             83 m |

Every state's own Q̂ lands coverage within 3pp of 90% — the conformal machinery is sound. What varies
is the **factor itself**, monotonically with rurality: dense NY needs 1.53×, extreme-rural MT needs
2.85×. The uncalibrated column shows why MT is the extreme — its raw radius covers only 62.7% as-is
(rural addresses are spaced far less uniformly along their long TIGER segments than the interpolation's
uniform-spacing assumption allows), so it needs the biggest correction.

### Wider sample confirms it (12 states)

A partial 50-state sweep (abandoned at the >85 °C heat ceiling on the lab CPU — a sustained run of the
neural cascade) extended the five above to **twelve**, and the trend holds and widens. Ordered by Q̂:

| Q̂       | states                                      |
| ------- | ------------------------------------------- |
| 1.4–1.6 | **DC 1.44**, NY 1.53 (densest urban)        |
| 1.7–2.0 | TX 1.70, AK 1.72, CA 1.87, CT 1.91, MI 1.93 |
| 2.2–2.9 | AR 2.24, CO 2.29, AL 2.79, MT 2.85          |
| 3.0+    | **AZ 3.12** (sprawl / long rural segments)  |

A **2.2× spread** (DC 1.44 → AZ 3.12), monotonic with rurality. The five-state read wasn't a small-sample
fluke — it's the real shape. The seed table (`data/calibration/interp-radius-conformal.json`) carries all
twelve; the full 50 is a turn-key follow-up (mind the heat ceiling on a sustained sweep).

## What the shipped 1.70 actually does off-Texas

A single nationwide 1.70× is wrong in both directions, and one direction is dangerous:

- **Rural states are overconfident.** MT needs 2.85× for 90%; at 1.70× the radius claims a precision it
  doesn't have — a user is told "90% within R" and gets materially less. Overconfidence is the failure
  mode honest confidence exists to prevent.
- **Dense cities are over-conservative.** NY needs only 1.53×; at 1.70× the radius is wider than it
  needs to be — honest, but it throws away precision the data supports.

Texas (1.70) sits in the middle, which is exactly why a single-region calibration looked fine and
shipped — the artifact is the regional mean masquerading as a constant.

## Decision and recommendation

**Resolve the parked decision toward per-region.** Two shippable shapes:

1. **Per-region table (seed shipped here).** `data/calibration/interp-radius-conformal.json` carries the
   five measured states + a **conservative default of 1.95** for unmeasured states — deliberately on the
   high side, because under-coverage (overconfidence) is the harmful error and most states skew rural.
   `geocode-core` would load the factor by parsed region instead of the hardcoded 1.70. Cheap; the full
   50-state table is a turn-key follow-up (the tooling is committed — ~2 min/state).
2. **Per-segment-length bucket (the principled refinement).** The real driver is segment length /
   local density, not the state line — a state like CA holds both dense LA and rural North State. A Q̂
   indexed on the claimed radius (segment-length bucket) would generalize within a state and to
   unmeasured states. More work; the better long-term answer. Recommended as the follow-up to the seed
   table.

**Flagged, not auto-wired.** Loading a per-region factor changes the shipped `uncertainty_m` on every
interpolated geocode — a behavior change. Per the merge-wall discipline this is PR-and-flag: the seed
table + this evidence land; the operator decides whether to wire per-region now (table) or hold for the
per-segment-length version. The single 1.70 stays the default until then — with this report on record
that it under-covers rural geocodes.

## Reproduce

```bash
node scripts/eval/build-situs-holdout.mjs --shard <state-situs.db> --region <ABBR> --n 2000
node --experimental-strip-types scripts/eval/conformal-calibrate.ts \
  --holdout /tmp/<abbr>-situs-holdout.jsonl \
  --address-points /tmp/empty-situs.db \   # tableless → situs no-op → interp-only (#568)
  --interpolation <state-interp.db>
# or scripts/eval/run-conformal-multistate.sh for the whole sweep
```

See also: [`2026-06-14-interp-radius-calibration.md`](./2026-06-14-interp-radius-calibration.md) (the
original Texas 1.70 calibration, #569).
