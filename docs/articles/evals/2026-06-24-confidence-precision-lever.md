# A precision lever you can dial — calibrated confidence on messy input (v4.13.0)

_2026-06-24. Shipped model `neural-weights-en-us` v4.13.0 (int8), calibrated via the v4.13.0 isotonic table. 472 held-out OpenAddresses coordinate goldens across us/it/pt/pl/fr/au (≤80/locale), each perturbed to be messy: lowercased, comma-stripped, common street words abbreviated, dash-postcodes dropped — the house number untouched. Coordinate-graded right-place @25km ("no result" counts as a miss). Per-result confidence = the minimum calibrated confidence across the resolved nodes (a coordinate is only as trustworthy as its least-sure driving component)._

## The claim

A geocoder that returns a best guess gives you one number and no way to know which answers to trust. mailwoman returns a coordinate **and** a calibrated confidence, so you can set a threshold τ and accept only the answers it is at least τ confident about. As τ rises, precision rises and recall falls — a lever no search index exposes. The question this report answers: does that lever actually work — does higher confidence mean higher right-place rate, and does it hold on data the curve was not drawn on?

## The lever (draw split, 236 rows)

Sweep τ; at each, precision is right-place @25km among the answers at or above τ, recall is the fraction of all rows answered at or above τ.

| τ | accepted | precision @25km | recall |
| --: | --: | --: | --: |
| 0.00 | 159 | 84.3% | 67.4% |
| 0.70 | 147 | 85.0% | 62.3% |
| 0.80 | 115 | 92.2% | 48.7% |
| 0.90 | 79 | 93.7% | 33.5% |
| 0.94 | 37 | 97.3% | 15.7% |
| 0.97 | 29 | 96.6% | 12.3% |

Precision climbs from 84.3% to 97.3% as the threshold rises; recall is the price, falling from 67% to 16%. The confidence is not decoration — it ranks answers by how likely they are to be right.

## The honesty check (held-out 50%, 236 rows the curve was not drawn on)

A confidence story a judge can break is worse than none. Split the rows at the draw-split median confidence (0.900) and re-measure right-place on the **held-out** half:

| held-out bucket | n | right-place @25km |
| --- | --: | --: |
| confidence < 0.900 (low) | 68 | 72.1% |
| confidence ≥ 0.900 (high) | 92 | 85.9% |

The high-confidence bucket outperforms the low-confidence bucket by 13.8pp out-of-sample. The discrimination is a property of the shipped model, not of the slice the curve was fit on.

## Where the confidence comes from (per-locale, τ=0)

| locale | n | precision @25km | recall | reads as |
| --- | --: | --: | --: | --- |
| US | 80 | 94% | 85% | covered — precise and confident |
| IT | 80 | 94% | 99% | covered |
| FR | 80 | 91% | 100% | covered |
| PT | 80 | 76% | 31% | building — correctly less confident |
| PL | 80 | 28% | 36% | building — correctly low confidence |
| AU | 72 | 63% | 53% | building |

The discrimination is the model flagging its own coverage. Where mailwoman has gazetteer depth (US, IT, FR) it is both precise and confident; where coverage is still being built (PL, PT, AU) it is correctly unsure, so a τ threshold removes exactly those answers. That is the asset: for a caller who must avoid wrong answers — a record-matcher deduping compliance data, say — the threshold cuts the error rate by trusting only the answers the model stands behind. Coverage breadth is a separate axis, tracked elsewhere.

## What this report does NOT claim

The plan opened as a head-to-head against Nominatim on the same messy set. That comparison is **withheld**: the Nominatim fetch hit rate-limiting during crash-restarted runs (AU returned nothing for all 63 valid AU addresses, FR 45% null, PT 38% null), so the competitor's recall and precision are unreliable here and any "mailwoman wins" read would be a rate-limit artifact. The clean competitive result stands from the 2026-06-23 benchmark (US right-place @25km, mailwoman 99% vs Nominatim 84%, #775) as supporting context, not as tonight's measurement. A spaced, policy-respecting re-fetch is the next step if the head-to-head on mess is wanted.

## Reproduce

```bash
node --experimental-strip-types scripts/eval/confidence-discrimination.ts \
  --locales us,it,pt,pl,fr,au --n 80 --rows-out /tmp/rows.jsonl --out scorecard.md --svg curve.svg
# re-analyze instantly from the cached rows (no re-parse, no API):
node --experimental-strip-types scripts/eval/confidence-discrimination.ts --rows-in /tmp/rows.jsonl --agg min
```

The harness separates collection (parse + resolve + grade, the expensive part) from analysis (sweep + plot), checkpoints every row so a crash resumes, and rate-limits Nominatim only on a cache miss.
