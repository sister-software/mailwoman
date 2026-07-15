# 2026-07-14 — v263 country-channel (#1104): grade result + the promote decision

v263 (`v2.6.3-country-channel`) activates the dedicated country soft-feed channel (#1104) — the permanent
fix for the country regression that v261 (6.1.0) shipped as a documented cosmetic exception. It is an
`init_from` fine-tune off v261 (single variable: the country channel ON), trained 8k steps on A100
(loss 0.9745, `macro_f1` 0.748 held, no NaN). Model int8 md5 `34289d215e0c1ba1e663337999ca3cbd`.

**The channel works. It recovers country and holds the assembled coordinate. It also introduces a
coordinate-invisible per-tag region trade. The promote-to-default call is the operator's — mirroring the
v261 documented-exception decision — because the region delta is a per-tag regression not pre-approved.**

## Grade (package-shaped throughout — `--weights-cache`, never `--model` alone, #718)

| Gate                                                  | shipped (v261 / 6.1.0) | v263                         | verdict                                                             |
| ----------------------------------------------------- | ---------------------- | ---------------------------- | ------------------------------------------------------------------- |
| **PRIMARY — golden country recall**                   | 190/224 = **84.8%**    | 200/224 = **89.3%**          | ✓ +4.5pp — clears the 88.6% v241 bar; fixes 19, breaks 9 (net +10)  |
| **GUARD — real-postal country recall** (falsifier)    | 3/4                    | 3/4                          | ✓ identical                                                         |
| **GUARD — hallucination** (300 real no-country rows)  | 1%                     | 1%                           | ✓ identical                                                         |
| **NON-INF — held-out US coordinate** (300 FDIC, ≤5km) | 279                    | 278 (z −0.16)                | ✓ PASS — not significantly worse                                    |
| **NON-INF — held-out FR coordinate** (300 BAN, ≤5km)  | 281                    | 280 (z −0.17)                | ✓ PASS                                                              |
| **gauntlet regression + metamorphic**                 | PASS                   | PASS (same 6 tracked xfails) | ✓                                                                   |
| **per-tag region** (golden, exact-match)              | 556 fails              | 580 fails                    | ⚠ **+24 — the region trade**                                        |
| **country-homograph** F1 (real, n=54)                 | 89.8 (country-OFF)     | **82.6** (country-ON)        | ⚠ **−7.2pp — the homograph trade** (surfaced by the ledger tooling) |

Country/postcode/hn/street/locality per-tag deltas on golden are small (postcode +6, street +5, locality
+4, hn +2); aggregate label-fails 1805 → 1835 (+30), dominated by region. Note the two country lenses
disagree by design — see the two trade sections below.

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

## The homograph trade — the country channel cuts both ways (surfaced 2026-07-14 by the ledger tooling)

The `--weights-cache` promotion-gate path added for the ledger backfill graded v263 package-shaped on the
`country-homograph-real` probe (n=54) and exposed a **second, country-side** trade the golden grade above
did not measure. v263's country channel is a 2-dim `[country_surface, country_ambiguous]` feature; the
`country_ambiguous` bit is a learnable false-positive guard for homograph surfaces (a country name that is
also a US state, a city, or a common word). It works — but on this all-homographs-are-countries test it is
_too_ conservative: v263 (country-ON) misses exactly three rows country-OFF emits — **Georgia** (US state),
**Jordan** (given name), **Jamaica** (NYC neighborhood) — and gains none, so country F1 drops **89.8 → 82.6**.

This is the mirror image of the WOF-admin win. On the leading-long-form WOF-admin distribution (golden, the
#1104 target) the channel _lifts_ country recall 84.8→89.3%; on the trailing-homograph distribution it
_trades_ recall for precision. The net is coordinate-invisible — the held-out coordinate z-test passed on
both locales, and the `country_ambiguous` guard's whole purpose is fewer false "Georgia → country" emissions
on real mixed input, which the homograph-recall test cannot credit. It does not change the v263 ship
(coordinate is the ship gate, #566), but it sharpens the country story: **v263 helps admin-hierarchy country
and trades a little homograph-country recall for homograph precision.** A future tune could soften the
guard (a lower `country_ambiguous` weight) if the homograph-recall lens is judged to matter more than the
precision it buys. Recorded in `evals/scores-by-version.json` (the 6.2.0 row's `us.country_homograph`).

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
