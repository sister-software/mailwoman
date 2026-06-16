# #655 — can a re-thresholded dedup GBT beat the FS spine on cross-source linking?

_Measurement for #655. The default-on GBT (#603) is pinned **off** for cross-dataset flows
(cross-dataset-correlation, coverage-reconciliation, `registry --sources`) because it suppresses the
"same facility, different operational name across sources" links those flows exist to find. The open
question: is that a **threshold** artifact (option 1 — keep the GBT, recalibrate a lower link
threshold for the cross-source objective) or structural (the GBT can't do this job, so a
cross-objective **retrain** (option 2) is the only lever)? This settles it with a sweep._

## Method

`scripts/record-matcher/cross-source-threshold-sweep.ts`. TX-scoped, ≤2000 rows/source (NPPES org
NPIs + TX HHSC nursing facilities + FCC-RHC filings), geocoded **once**, then resolved repeatedly:
the FS spine (the recall-correct baseline the flows currently pin) and the bundled dedup GBT swept
across link thresholds from −8 up through its dedup threshold (2.71). The GBT logit **replaces** the
FS weight, so lowering the threshold is the only knob.

**Precision proxy (label-free):** there is no cross-source ground truth — no shared key across the
three datasets is the whole premise. So we use **phone corroboration**: of the cross-source entities
whose records carry a phone in ≥2 different sources, the fraction whose phones **match**. Phone is not
the join key, so a match is independent evidence of same-facility. (Small-N + noisy — see caveats.)

## Result (cap 2000, TX)

| arm          | threshold | total entities | cross-source links | triple | phone-corrob (of checkable) |
| ------------ | --------: | -------------: | -----------------: | -----: | --------------------------- |
| **FS spine** |         0 |       **3343** |             **27** |      0 | **10/27 (37%)**             |
| GBT @ −8     |        −8 |            115 |                 52 |      3 | 17/52 (33%)                 |
| GBT @ −6     |        −6 |            115 |                 52 |      3 | 17/52 (33%)                 |
| GBT @ −5     |        −5 |            115 |                 52 |      3 | 17/52 (33%)                 |
| GBT @ −4     |        −4 |            115 |                 52 |      3 | 17/52 (33%)                 |
| GBT @ −3     |        −3 |            115 |                 52 |      3 | 17/52 (33%)                 |
| GBT @ −2     |        −2 |           2382 |                153 |     24 | 29/151 (19%)                |
| GBT @ −1     |        −1 |           2382 |                153 |     24 | 29/151 (19%)                |
| GBT @ 0      |         0 |           2869 |                 56 |      2 | 15/55 (27%)                 |
| GBT @ 1      |         1 |           3041 |                 47 |      2 | 10/46 (22%)                 |
| GBT @ 2      |         2 |           3543 |                 16 |      0 | 3/15 (20%)                  |
| GBT @ 2.71   |    2.7143 |           3605 |                 11 |      0 | 3/10 (30%)                  |

## Verdict — threshold alone (option 1) is INSUFFICIENT

The decisive, config-independent signal is the **total-entity column**:

1. **At its dedup threshold (2.71), the GBT finds _fewer_ cross-source links than FS** (11 vs 27) — it
   suppresses exactly the links the cross-source flows want, confirming the #603 follow-up's premise.
2. **To make the GBT admit _more_ cross-source links, you must lower the threshold until the whole
   clustering collapses.** As the threshold drops, total entities fall 3343 → 2869 → 2382 → **115**.
   The "52 links / 33%" plateau at threshold ≤ −3 is an artifact of ~6000 records collapsing into 115
   giant blobs — those blobs trivially span sources; they are not facility matches.
3. **No threshold reproduces FS's precision.** FS sits at 37% phone-corroboration; every GBT arm is
   below it, and the arms that gain links (thr ≤ 0) do so at 19–27% — lower precision _and_ more
   over-merging.

There is no GBT link threshold that matches FS's cross-source links at ≥ FS precision **without**
over-merging. This is structural, not a tuning miss: the GBT's strongest features
(`spatial-exact × name/org-disagree`) **replace** the FS weight, so a true cross-source pair (same
place, names differ across sources) lands in the same logit band as a genuine dedup over-merge (same
place, different co-located provider). One threshold cannot separate the two when the objectives are
opposite — which is the definition of needing a different model, not a different cutoff.

**FS stays pinned for the cross-source flows** — it is the recall-correct _and_ best-precision tool
here, by design. The only way to "do better than FS" (#655) is a **cross-objective retrain**
(option 2): a GBT trained on the cross-source objective, where `spatial-exact × name-disagree` carries
the _opposite_ sign. That is gated on cross-source labels, which don't exist (no shared key) — it
needs a weak-label pipeline (e.g. phone/NPI-corroborated FS-high-confidence links as positive seeds,
non-co-located pairs as negatives). That is a project, not a tweak; it is **not** started here.

## Caveats

- **Small cross-source N.** This strict config (`collapseSpatial` + the production address-frequency
  basis the GBT was trained on) yields only **27** FS cross-source entities at cap 2000 — far fewer
  than the **219** an earlier, looser cross-dataset-correlation FS run reported. The absolute counts
  are config-dependent and not comparable across configs. What's valid here is the **relative**
  FS-vs-GBT comparison (same config, same data, same run) and the entity-collapse pattern — both
  robust regardless of absolute scale.
- **The phone proxy is noisy** at N=27 (only 10–29 checkable per arm). It corroborates the conclusion
  but isn't load-bearing; the entity-collapse evidence (point 2) is.
- A higher-cap run would tighten the precision proxy but cannot change the structural finding: the
  GBT only yields more cross-source links by over-merging.

## Bottom line

Option 1 (re-threshold the dedup GBT) **does not work** — measured, not assumed. Keep FS pinned for
cross-source discovery. #655's remaining content is option 2 (a weak-label cross-objective retrain),
which is a scoped project gated on building cross-source weak labels — or, equally defensible, close
#655 as "the GBT is dedup-only by design; FS is the correct cross-source tool."
