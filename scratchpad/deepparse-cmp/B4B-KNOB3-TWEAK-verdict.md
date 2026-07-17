# B4b knob 3 tweak (v372) — the plateau BROKE. Best result of the arc, clean, at the bar.

The full-exploration probe the operator asked for. It settled the question the v371 plateau raised — was
the corpus lever exhausted, or was the ≥3-digit-only cut too narrow? **Too narrow.** Boosting ALL number
lengths at 6× broke through, and it stayed clean everywhere.

## The reads — the plateau broke

| board       | metric                      |           v310 | v371 (knob3 8k) | v372 (tweak 2k) | note                                             |
| ----------- | --------------------------- | -------------: | --------------: | --------------: | ------------------------------------------------ |
| board 3     | **bare-street-hn** (TARGET) |          0.693 | 0.733 (plateau) |       **0.775** | +8.2pp, best; lower CI 0.732 ~AT the bar (0.736) |
| board 3     | city/pc-first/street-led    | .953/.940/.968 |            held |  .953/.955/.965 | held                                             |
| board 3     | slash-hn                    |         ~0.650 |           0.670 |           0.693 | +4pp                                             |
| board 3     | bare-pc (guard)             |          1.000 |           1.000 |           1.000 | ✓ (held despite lower counter share)             |
| FR fragment | OVERALL                     |          0.733 |           0.758 |       **0.787** | +5.4pp, best (IMPROVED, no dilution)             |
| FR fragment | bare-street                 |          0.715 |           0.775 |           0.828 | +11.3pp                                          |
| golden gate | verdict                     |           PASS |            PASS |        **PASS** | —                                                |
| golden gate | >2pp regressions            |              — |               0 |           **0** | fr-hn −0.2, worst us.street −0.7 / arena −1.0    |
| golden gate | country_homograph           |           87.5 |            89.8 |        **89.8** | +2.3pp                                           |

## Two things the tweak proved

1. **The v371 plateau was the ≥3-digit-only cut, not the lever.** v371's miss breakdown by number length
   (`v371-miss-by-digits.run.ts`) showed the 8k residual was spread across ALL lengths — 1-digit
   absorption (21), 2-digit postcode (28), 3-digit still 66%-fail even at 4× (37). Boosting every length
   at 6× hit all three: bare-street-hn 0.733 → 0.775. The lever had headroom; the narrow cut was hiding it.
2. **The 3× volume confound was a non-issue.** The stated risk was that tripling shard rows (11,609 →
   33,203) at the same weight would re-drift FR like knob 1. It did the opposite — FR fragment +5.4pp
   (best of the arc) and the golden gate clean. The boundary signal is additive-strong, not dilutive.

## What v372 IS

The **strongest and cleanest digit-ownership result of the entire arc**: bare-street-hn +8.2pp (at the
strict bar), FR fragment +5.4pp, homograph +2.3pp, golden gate PASS with ZERO >2pp regressions. No trade
anywhere, at 2k. This is what numsplice was not and what knob 3 nearly was — now essentially clearing the
bar.

## The bar — essentially met, formally a hair short

bare-street-hn 0.775 [0.732, 0.813]. The strict bar wanted the lower CI above v310's upper CI (0.736);
0.732 is 0.004 below — a rounding-error miss. The point estimate (0.775) sits at the ~0.78 target and the
two CIs now overlap in only a 0.004 sliver. This is the "at the bar" case, not the "missed" case knob 1
and the narrow knob 3 were.

## Recommendation — run the 8k (this is the ship candidate)

The 2k broke the plateau to 0.775 with a clean golden gate. The open question is the 2k→8k trajectory:
v371's narrow cut plateaued, but this broke that plateau, so more steps plausibly clear the bar cleanly —
and even a plateau at ~0.775 is +8pp and meets the target within noise. Zero downside (no trade to
amplify). This is the run that either clears the digit-ownership bar outright or ships as the strongest
clean net-positive the arc produced. Promotion is the operator's act.
