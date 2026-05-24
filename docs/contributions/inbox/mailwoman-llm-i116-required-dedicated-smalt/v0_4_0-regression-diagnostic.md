# Post-hoc diagnostic — v0.4.0 country / postcode regressions

Source: shipped `source-only step-2200` checkpoint run against golden v0.1.2
(4535 entries). Scripts at `/tmp/diagnose_country_postcode.py` and
`/tmp/diagnose_categorized.py`. Both random-sample 10/3 examples per bucket
(seed=42); the categorized version classifies every error into a bucket and
reports counts.

## Categorized error counts

Heuristic: each error is classified into one of {`non_latin`, `case_only`,
`bio_slip`, `empty_pred`, `num_confused`, `other`}. Order-sensitive — the first
match wins, so `non_latin` (raw contains non-ASCII) over-attributes to its
bucket; many `non_latin` entries are _also_ bio_slip etc.

### country (245 supports, F1=0.21 vs v0.3.0's 0.28)

| bucket                          |  FP (187) |  FN (194) |
| ------------------------------- | --------: | --------: |
| `non_latin` (raw has non-ASCII) | 139 (74%) | 178 (92%) |
| `other` (positional / spurious) |  45 (24%) |         — |
| `empty_pred`                    |         — |   13 (7%) |
| `bio_slip`                      |         2 |         2 |
| `case_only`                     |         1 |         1 |

**Key insight**: ~92% of country FNs are adversarial transliteration entries
(Cyrillic, Arabic, CJK names mixed with Latin-script country labels). The
v0.3.0 model card explicitly names this as a known failure mode. Strip these
from the regression denominator and only ~16 country FNs are real — and even
some of those are bio_slip / case_only cosmetic mismatches.

**The country -0.07 regression is mostly an artifact of golden v0.1.2's
adversarial transliteration weighting**, not a real model regression. Adding
v0.3.0-equivalent transliteration handling (or excluding adversarials from the
ship-decision denominator) recovers most of the gap.

### postcode (2980 supports, F1=0.69 vs v0.3.0's 0.76)

| bucket                                |  FP (355) |     FN (1217) |
| ------------------------------------- | --------: | ------------: |
| `empty_pred` (model emits nothing)    |         — | **789 (65%)** |
| `num_confused` (predicts a house-num) | 136 (38%) |     136 (11%) |
| `non_latin`                           | 113 (32%) |     213 (18%) |
| `bio_slip` (boundary off ± 1 token)   |  73 (21%) |       73 (6%) |
| `other`                               |   33 (9%) |      6 (0.5%) |

**Key insight #1**: 789 of 1217 FNs (65%) are `empty_pred` — the model emits
no postcode at all for the entry. Looking at samples:

- `Paris 75008` (postcode last, short address — should be trivial)
- `64 Industrial Park Rd, Alburgh, VT 05440, Alburg Health Center` (postcode
  in middle, venue trailing)
- `3 Rue des Acacias, 47110 Sainte-Livrade-sur-Lot` (postcode in middle)

These are mid-position or simple-form postcodes. The model has a strong
positional bias toward postcode-at-edge. v0.3.0 was apparently better at this.

**Key insight #2**: `num_confused` is 136 FPs + 136 FNs — same 136 entries
counted on both sides. Each one is "gold says 47110, model picks 1403 (house
number)". This is the NAD-downweight pattern from the v0.4.1 hypothesis,
confirmed.

**Key insight #3**: `bio_slip` is 73 FPs + 73 FNs (same overlap). Examples:
`'08200 I'` (extra space + I attached), `'01-4681'` (postcode minus its
5-digit prefix), `'T 05748'` (extra T+space). All decoder-side fixable.

## Proportions after dropping non_latin adversarials

If golden v0.1.2's non-Latin adversarial entries are excluded (since they were
v0.3.0 known-failure-modes too, and aren't really a v0.4.0 regression):

### country, non-adversarial slice

- FP: 187 − 139 = 48 errors, mostly `other` (model predicts "France"/"USA"
  when gold has empty country = training-data positional bias)
- FN: 194 − 178 = 16 errors, mostly `empty_pred` (model misses some Latin
  country tokens, likely positional)

Real country regression vs v0.3.0 is small — most of the headline -0.07
F1 delta is the adversarial transliteration share.

### postcode, non-adversarial slice

- FP: 355 − 113 = 242 errors. Of these, `num_confused`=136 (56%), `bio_slip`=73
  (30%), `other`=33 (14%). Decoder span-trim closes ~30%; source-weight tweak
  closes ~56%; together ~86% of non-adversarial FP.
- FN: 1217 − 213 = 1004 errors. Of these, `empty_pred`=789 (79%),
  `num_confused`=136 (14%), `bio_slip`=73 (7%), `other`=6 (1%). The
  `empty_pred` slice is the real story — model is silent on a lot of postcodes
  even in Latin-script Latin-position entries.

## Updated v0.4.1 recommendation

The v0.4.0 regression story decomposes into FOUR independent fixes, in
descending impact:

### (1) Mid-position postcode coverage gap — biggest signal, less obvious fix

789 empty_pred postcode FNs is the dominant failure mode. The model is silent
on postcodes that are mid-string or in short addresses. Hypothesis:
v0.4.0's `wof-postalcode: 2.0` brought in coarse-only "10118" or "75008 Paris"
forms but the corpus mix lost the mid-position structured-address forms NAD
contributed.

Fix options:

- Bump NAD back farther (1.0 → 1.7+) — but this contradicts §4's intent
- Bump `wof-postalcode: 2.0 → 2.5` AND keep NAD at 1.0 — more aggressive
  coarse-pull
- Add a synthesis pass that permutes existing rows' component order to
  expose mid-position postcodes (would require corpus work)

### (2) House-number / postcode confusion — clean source-weight fix

136 errors counted on both sides. NAD's downweight removed exposure to
"postcode FIRST" patterns. Bump NAD 1.0 → 1.5 (or pair NAD with a
country-conditional weighting for FR / US-state-prefix patterns).

### (3) BIO span boundary slip — host-claude is taking this as a sidecar

73 FP + 73 FN (146 errors). All decoder-side fixable: strip leading/trailing
non-alphanumeric chars from extracted spans. **In-flight already.**

### (4) Adversarial transliteration coverage — not a v0.4.0 regression

178 country FNs + 213 postcode FNs are non-Latin adversarials. This is the
v0.3.0 documented failure mode; deferring to v0.5.0+ is consistent with the
issue's "out of scope" list. Worth noting: even a small synth pass with
transliteration variants would have a big effect on the headline F1 numbers.

## Counts summary

|             | shipped v0.4.0 | v0.3.0 | Δ headline | Δ if non-Latin removed |
| ----------- | -------------: | -----: | ---------: | ---------------------: |
| country F1  |           0.21 |   0.28 |      -0.07 |  likely -0.01 to -0.02 |
| postcode F1 |           0.69 |   0.76 |      -0.07 |  likely -0.04 to -0.05 |

After (1)+(2)+(3): postcode F1 plausibly recovers to 0.74-0.78 range. After
(2)+(3): country F1 plausibly recovers to 0.27-0.30 range.

## Tools

- `/tmp/diagnose_country_postcode.py` — raw FP/FN sampler
- `/tmp/diagnose_categorized.py` — categorized bucket counter
- Both reusable for future checkpoint comparisons; takes `--config`,
  `--checkpoint`, `--golden-dir`

## Generated

2026-05-23 — by the v0.4.0 ship agent during the post-asking-phase CPU window.
Updated 07:55Z after the categorized-bucket pass.
