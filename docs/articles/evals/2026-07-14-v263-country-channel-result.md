# 2026-07-14 — v263 country-channel (#1104): grade result + the promote decision

v263 (`v2.6.3-country-channel`) activates the dedicated country soft-feed channel (#1104) — the permanent
fix for the country regression that v261 (6.1.0) shipped as a documented cosmetic exception. It is an
`init_from` fine-tune off v261 (single variable: the country channel ON), trained 8k steps on A100
(loss 0.9745, `macro_f1` 0.748 held, no NaN). Model int8 md5 `34289d215e0c1ba1e663337999ca3cbd`.

**The channel works. It recovers country and holds the assembled coordinate. It also introduces a
coordinate-invisible per-tag region trade. The promote-to-default call is the operator's — mirroring the
v261 documented-exception decision — because the region delta is a per-tag regression not pre-approved.**

## Grade (package-shaped throughout — `--weights-cache`, never `--model` alone, #718)

| Gate                                                  | shipped (v261 / 6.1.0) | v263                         | verdict                                                            |
| ----------------------------------------------------- | ---------------------- | ---------------------------- | ------------------------------------------------------------------ |
| **PRIMARY — golden country recall**                   | 190/224 = **84.8%**    | 200/224 = **89.3%**          | ✓ +4.5pp — clears the 88.6% v241 bar; fixes 19, breaks 9 (net +10) |
| **GUARD — real-postal country recall** (falsifier)    | 3/4                    | 3/4                          | ✓ identical                                                        |
| **GUARD — hallucination** (300 real no-country rows)  | 1%                     | 1%                           | ✓ identical                                                        |
| **NON-INF — held-out US coordinate** (300 FDIC, ≤5km) | 279                    | 278 (z −0.16)                | ✓ PASS — not significantly worse                                   |
| **NON-INF — held-out FR coordinate** (300 BAN, ≤5km)  | 281                    | 280 (z −0.17)                | ✓ PASS                                                             |
| **gauntlet regression + metamorphic**                 | PASS                   | PASS (same 6 tracked xfails) | ✓                                                                  |
| **per-tag region** (golden, exact-match)              | 556 fails              | 580 fails                    | ⚠ **+24 — the trade**                                              |

Country/postcode/hn/street/locality per-tag deltas on golden are small (country −10; postcode +6, street
+5, locality +4, hn +2); aggregate label-fails 1805 → 1835 (+30), dominated by region.

## The region trade — real, but coordinate-invisible

The region regression concentrates on **trailing-country tails**: v263 drops the region on inputs like
`Cider Mill Rd VT 05161, US`, `STATE RTE 100, VT 05350, USA`, and FR `Manailly Creuse FRANCE` — 11 rows
that shipped labels correctly, region → `""`. Mechanism: the dedicated country channel (immune to
`suppress_gazetteer_near_postcode`) fires on the trailing country surface and out-competes the adjacent
region tag on that boundary. It is a genuine v263 behavior, not a near-miss.

**But it does not move the assembled coordinate.** The #566-correct measure — the held-out coordinate
z-test on 300 fresh real US/FDIC and 300 fresh real FR/BAN addresses — is flat in both locales (z −0.16 /
−0.17, PASS). The golden region misses are on redundant-trailing-country formats that real-address draws
don't emphasize; the resolver still pins those without the region. This is the same class as v261's
documented country exception, in the opposite tag: a per-tag delta that the coordinate does not see.

## The decision — operator's, per the v261 precedent

The night-shift 2pp pre-publish gate aborts a promotion on any tag regressing >2pp from the default
**unless the operator pre-approved the trade**. The region regression was not pre-approved (the greenlit
retrain targeted country recovery). So — exactly as v261 shipped only because the operator said "promote
with the documented exception" — the promote-to-default call for v263 is the operator's, with this trade
on the table.

**Recommendation: promote.** v263 recovers the #1104 country target with the real fix (the atlas channel,
not a cosmetic exception), holds the real-postal guard, and is coordinate-flat on both locales. The region
cost is coordinate-invisible and on a low-prevalence format. If instead the region per-tag delta is judged
unacceptable, the channel is validated and the next iteration is a targeted region-preservation tune (a
lower country-channel confidence near a region-abbrev, or a region class-weight bump), not a rebuild —
the channel code is already merged (default-OFF) on main.

## Reproduce

- Config: `corpus-python/src/mailwoman_train/configs/v2.6.3-country-channel.yaml` (init_from v261 step-008000).
- Grade: `scratchpad/grade-v263.sh` (export → quantize → package-cache → falsifier + failure-report + gauntlet).
- Cross-model report: `docs/articles/evals/competitive-parity/2026-07-14-v263-country-channel.mdx`.
- Channel code: merged in #1116 (`1c40dd7e`), default-OFF; `data/gazetteer/country-surface-lexicon-v1.json`.
