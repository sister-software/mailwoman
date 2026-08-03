# #655 — cross-source threshold sweep: can a re-thresholded GBT beat FS?

_TX-scoped, ≤2000 rows/source (NPPES org + TX HHSC nursing = eligibility-ish; FCC-RHC = funding), geocoded once then resolved per arm. **Phone-corrob** = of the cross-source entities whose records carry a phone in ≥2 different sources, the fraction where those phones MATCH — a label-free precision proxy (phone is not the join key). Higher cross-source + higher phone-corrob = better._

| arm              |          threshold | total entities | cross-source links | triple-source | phone-corrob (of checkable) |
| ---------------- | -----------------: | -------------: | -----------------: | ------------: | --------------------------- |
| FS baseline      |                  0 |           3355 |                 27 |             0 | 15/27 (56%)                 |
| GBT @ -8.00      |                 -8 |            106 |                 60 |             7 | 23/60 (38%)                 |
| GBT @ -6.00      |                 -6 |            106 |                 60 |             7 | 23/60 (38%)                 |
| GBT @ -5.00      |                 -5 |            106 |                 60 |             7 | 23/60 (38%)                 |
| GBT @ -4.00      |                 -4 |            106 |                 60 |             7 | 23/60 (38%)                 |
| GBT @ -3.00      |                 -3 |           4927 |                  0 |             0 | 0/0 (—)                     |
| GBT @ -2.00      |                 -2 |           4927 |                  0 |             0 | 0/0 (—)                     |
| GBT @ -1.00      |                 -1 |           4927 |                  0 |             0 | 0/0 (—)                     |
| GBT @ 0.00       |                  0 |           4927 |                  0 |             0 | 0/0 (—)                     |
| GBT @ 1.00       |                  1 |           4927 |                  0 |             0 | 0/0 (—)                     |
| GBT @ 2.00       |                  2 |           4927 |                  0 |             0 | 0/0 (—)                     |
| GBT @ 2.83       |             2.8324 |           4927 |                  0 |             0 | 0/0 (—)                     |
| cross-GBT @ 1.47 | 1.4748999999999999 |           3239 |                 33 |             1 | 17/32 (53%)                 |
| cross-GBT @ 2.47 |             2.4749 |           3239 |                 33 |             1 | 17/32 (53%)                 |
| cross-GBT @ 3.47 |             3.4749 |           4927 |                  0 |             0 | 0/0 (—)                     |

## Verdict

FS baseline: **27** cross-source links (0 triple), phone-corrob 56% (15/27).

**No GBT threshold dominates FS** — none matches FS's 27 cross-source links at ≥ its 56% phone-corrob without over-merging (entity count collapsing below 3019). At its dedup threshold the GBT finds FEWER cross-source links than FS; lowering the threshold to admit more only over-merges (the over-merge features REPLACE the FS weight, so true cross-source pairs share a logit band with genuine over-merges). Threshold alone (option 1) is **INSUFFICIENT** — FS stays pinned (correct + best-precision for this objective); a cross-objective retrain (option 2), gated on cross-source labels, is the only lever. See #655.

## Candidate verdict (org-cross-GBT, added at review — the run predates the harness's candidate-verdict wiring)

The `--candidate` org model (`org-crosssource-gbt-en-us.ts` @ its recommended 2.47): **33 cross-source
links vs FS's 27 (+22%)** at 3,239 entities (above the 3,019 no-collapse floor), phone-corrob **17/32
(53%) vs FS 15/27 (56%)** — more corroborated links in ABSOLUTE terms (+2), a −3pp rate that is exactly
one-link noise at n=32 (the harness's own caveat: the phone proxy "corroborates but isn't decisive").
No dedup-GBT collapse signature (its arms sit at 106 entities or 0 links).

**Reading:** the org-cross-GBT is the first scorer to EXCEED FS's link discovery on the org flows
without over-merging. It misses STRICT dominance only on the noisy proxy's rate. Recommendation:
un-pin FS for the org-level cross-dataset flows as an operator decision (the flip is a config default,
not this eval's to make); alternatively hold FS pinned and re-judge after widening the label set with
the other Care Compare families (dialysis/hospice/SNF/HHA), which should tighten the proxy's n.
