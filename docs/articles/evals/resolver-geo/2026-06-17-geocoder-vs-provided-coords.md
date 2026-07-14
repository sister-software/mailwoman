# Geocoder vs provided coordinates — TX HHSC nursing facilities (#619)

_2026-06-17. A free, real-world geocoder accuracy check: the TX HHSC nursing-facilities registry ships
an authoritative `Geo Location` (`lat,lon`) per facility, so we can geocode each facility's street
address with our own pipeline and measure the great-circle delta. 1172 facilities with a usable
address + in-state coordinate (3 skipped). Neutral scope: this measures GEOCODER ACCURACY on real
public addresses — it makes no claim about the facilities._

Reproduce: `scripts/record-matcher/txhhsc-to-oarow.ts` → `scripts/eval/oa-resolver-eval.ts
--eval <jsonl> --address-points address-points-us-tx.db --interpolation interpolation-us-tx.db`.

## Geocoder accuracy by tier (our pipeline: neural parse → resolver)

| tier                          |  coord p50 | coord p90 | coord p99 |        tier hit rate |
| ----------------------------- | ---------: | --------: | --------: | -------------------: |
| admin-centroid (city)         |     3.4 km |   27.2 km |  741.6 km |        100% (always) |
| **+ address-point (rooftop)** | **0.7 km** |   13.5 km |  486.8 km | **47.0%** (551/1172) |
| **+ interpolation (street)**  | **0.1 km** |    8.2 km |  476.7 km | **12.5%** (146/1172) |

**The finer tiers are the story.** The admin-centroid tier lands a facility in the right city — p50
3.4 km, which is just "the city's middle is a few km from the facility." Switch in the **address-point**
tier where we have a rooftop for the parsed street + number, and p50 collapses to **0.7 km**; the
**interpolation** tier (no exact point, interpolated along the street segment) lands p50 **0.1 km** —
100 m, street-accurate. The honest caveat is **coverage**: the rooftop tier fires on 47% of these
facilities and interpolation on a further 12.5%, so ~40% still fall back to the city centroid. The tail
(p99 ~470–740 km) is wrong-place resolutions, not tier imprecision — a handful of facilities whose
parse resolves to the wrong locality entirely.

## The honest surprise — v0 out-parses neural on this distribution

Graded through the same resolver, **the rules parser (v0) beats neural on locality-match here: 96.8% vs
90.1%** (and coord p50 3.0 vs 3.4 km). That is the **inverse** of the clean-OpenAddresses result, where
neural leads 84.0% vs 82.1% (`2026-06-17-per-type-headtohead.md`).

The cause, **confirmed** by a direct probe (`scripts/eval/case-check.ts`): these are **ALL-CAPS
facility records** (`214 JONES RD, ELKHART, TX 75839`), and the neural model — trained predominantly on
mixed-case text — degrades on them. On a 5-address spot-check, locality is correct **3/5 in all-caps vs
5/5 in title-case**, and the failure is a clean tokenization-boundary artifact: `PALESTINE` parses to a
locality of **`ALESTINE`** (the leading `P` is dropped) in all-caps, but `Palestine` parses correctly.
v0's dictionaries are case-folded by construction, so on a SHOUTING dataset that robustness wins.

This is a real "where we lose," with a **near-free fix** — and we built it (#690). `parse(…, {
normalizeCase: true })` title-cases a detected all-caps **ASCII** input before the model (detection is
strict: mixed-case and non-ASCII/accented input are left untouched, so the path is byte-stable by
construction). Re-running this eval with `--normalize-case`:

| metric                     | all-caps (default) |     + `normalizeCase` (#690) |
| -------------------------- | -----------------: | ---------------------------: |
| neural locality-match      |              90.1% | **99.7%** (now > v0's 96.8%) |
| address-point hit rate     |              47.0% |                    **61.8%** |
| coord p50 (admin)          |             3.4 km |                       2.8 km |
| coord p50 (+address-point) |             0.7 km |                   **0.1 km** |
| coord p99 (+address-point) |           486.8 km |                  **20.7 km** |

The fix doesn't just close the gap — it **overtakes** v0 on locality (99.7 vs 96.8) and collapses the
catastrophic-miss tail (p99 487 → 21 km), because correct localities resolve to the right place and the
parsed street/number then hits the rooftop shard more often (47% → 62%). The one cost: region dips
**100.0% → 98.0%** — title-casing the 2-letter state (`TX`→`Tx`) trips ~2% of region resolutions, a
small, fixable artifact (preserve all-caps 2-letter state codes) against a large net win. Ships
**default-OFF** behind the `normalizeCase` opt.

## Reading

- **The geocoder works where it has data.** On real TX facility addresses, the address-point + street
  tiers put p50 error at 0.1–0.7 km — rooftop-to-street accuracy, not city-centroid. The pre-geocoded
  seed (#619's other half) lets us skip re-geocoding where the source already carries an authoritative
  point; this validation is what justifies trusting our own coordinate where it doesn't.
- **Coverage, not precision, is the frontier.** ~40% of these facilities fall back to the city centroid
  for lack of a TX rooftop/interp hit on the parsed street — the address-point shard coverage is the
  lever, not the tier math.
- **Case robustness is a measurable neural gap.** All-caps compliance/registry data is common, and we
  lose 6.7pp of locality there vs the rules parser. Cheap to fix, worth fixing.
