# Coarse-placer (#244) — milestone 1: a calibrated closed-set placer + the OOD wall

_2026-06-14. The #244 coarse-placer is the tiny always-resident model that runs first, places an
address coarsely, and abstains ("probably off my loaded map") rather than emit a confident mis-parse —
the foundation of the selective-geography / tiered-loading story. Milestone 1 builds the data pipeline
and a pure-TS char-n-gram linear classifier, trained on CPU in minutes. It nails the closed-set task and
makes the case for milestone 2 (outlier exposure) concrete._

## What it is

A fastText-style **linear classifier** over hashed char 3/4/5-grams + Unicode-script presence tokens
(`core/coarse-placer/featurize.ts`), mapping an address string → one of 11 well-represented countries
with a temperature-calibrated confidence (`core/coarse-placer/coarse-placer.ts`). Pure, dependency-free,
browser-safe; the artifact is 2.9 MB fp32 today (quantizes to ~720 KB int8 — a milestone-3 concern).

- **Data** (`scripts/coarse-placer/build-dataset.mjs`): stratified sample from the v0.5.0 corpus —
  40k/5k/5k train/val/test **per country**, balanced (a flat sample is 94% US+FR). Classes: US, FR, GB,
  CN, NL, IT, DE, JP, ES, KR, TW (the corpus's well-represented set; the long tail is held for outlier
  exposure). Two corpus gotchas handled: DuckDB `USING SAMPLE` samples the table-then-filters (so we
  filter-then-sample), and the val/test shards only carry US/FR/DE (so all splits are drawn from train
  with our own per-country 80/10/10).
- **Train** (`scripts/coarse-placer/train.mjs`): multinomial logistic regression, plain SGD, ~minutes on
  CPU. Temperature fit on val by NLL minimization.

## Milestone 1 results

**In-distribution (test, n=55k):**

| metric | value |
| --- | --- |
| closed-set accuracy (argmax) | **96.63%** |
| accuracy @ abstain-below-0.5 | 95.61% |
| ECE (10-bucket) | 0.0548 |
| temperature | 1.0 (already well-calibrated) |

Per-class recall: US 99.4, FR 98.8, GB 98.8, NL 98.3, KR 95.7, JP 95.1, DE 94.3, CN 94.1, TW 93.5,
IT 92.8, ES 90.9. The errors are the expected ones — ES↔IT↔DE (European Latin overlap) and TW↔CN
(shared Han). Trains in ~2 epochs (val plateaus at 96.7%).

## The wall (and why milestone 2 is the point)

The threshold-only abstention does **not** solve out-of-distribution. Off-map scripts — Cyrillic,
Armenian, Greek, none of them among the 11 trained countries — are **confidently mis-classified**, not
abstained:

```
cyrillic/RU → DE @0.71     «Новосибирск, ул. Ленина 10»
armenian/AM → ES @0.84     «Երևան, Աբովյան փողոց 5»
greek/GR    → GB @0.88     «Αθήνα, οδός Ερμού 12»
```

Only 36% of off-map-script rows abstain. This is the classic softmax-overconfidence-on-OOD pathology: a
closed-set model has no "none of the above," so it spreads an off-map input's weak signal over the 11
classes and one wins with moderate-to-high confidence. The design anticipated exactly this — the fix is
**outlier exposure**: an explicit "other" class trained on off-map examples so the model learns the edge
of its own competence. That's milestone 2.

## Milestone 2 — outlier exposure → an explicit OTHER class (the wall, cleared)

The data unlock: the WOF `names` table carries native-script alternate names in dozens of languages
(rus/ukr/ara/ell/heb/hin/tha/kat/hye/…) — exactly the off-map scripts the model needs to learn to
abstain on. `scripts/coarse-placer/build-outlier-exposure.mjs` extracts ~44k of them, balanced
per-language and filtered to a genuinely off-map dominant script, PLUS an address-shaped sibling for each
(name + a house number) — because real off-map input mixes the script with Latin digits/abbreviations
("ул. Тверская, д. 1"), and the bare place name alone left a gap. Added as a 12th class, `OTHER`.

| metric | M1 (closed-set) | M2 (+ OTHER) |
| --- | --- | --- |
| off-map-script handling (route to OTHER / abstain) | 36% | **86%** |
| OTHER recall (test) | — | 92.2% |
| in-distribution accuracy | 96.6% | 95.0% |
| ECE | 0.055 | 0.050 |

The explicit OTHER class lifts off-map handling 36% → 86% at a ~1.6pp in-distribution cost — the design's
prediction, confirmed. The address-shaped augmentation was decisive (place names alone got only 59%): the
numeric/punctuation n-grams in a real address otherwise pull an off-map input toward a country.

## Next (milestone 3+)

1. **The Latin-off-map residual.** Off-map COUNTRIES in Latin script (Poland, Turkey, Brazil…) still
   mis-place — they share the script with the in-map European 11 and the OTHER training is non-Latin. The
   fix is full off-map *addresses* (OpenAddresses for more countries), not place names.
2. **Script/continent heads** — the design wants (script, continent, coarse-region); script is
   deterministic, continent is a grouping, coarse-region routes shard loading.
3. **Shrink + ship** — int8-quantize (≈720 KB), wire as the first pipeline stage + the #243 query-type
   router (bare-landmark → skip parser; address → parse).

Reproduce: `node scripts/coarse-placer/build-dataset.mjs && yarn compile && node scripts/coarse-placer/train.mjs && node scripts/coarse-placer/eval.mjs`.
