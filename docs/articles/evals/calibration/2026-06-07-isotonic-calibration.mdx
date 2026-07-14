# Isotonic confidence calibration — neural-weights-en-us v4.0.0

Post-hoc calibration of the decoder's per-span softmax confidence (the `conf=` a resolver or human reads off the parse). Method: isotonic regression (PAVA) over `(raw confidence, correct?)` pairs from a 50/50 OpenAddresses + training-corpus calibration set. Fit on 80%, every number below measured on the held-out 20%. Task #59 (#240 PR3).

> `correct?` is a normalized exact-or-token-subset span match (so street decomposition and multi-word fragmentation aren't penalized), so the absolute accuracy runs mildly optimistic — isotonic corrects the reliability _shape_, which the lenient threshold leaves intact. The corpus half is in-domain (the model trained on it); the OA-only row above is the trustworthy held-out ECE.

## Headline

| Split                           | ECE raw | ECE calibrated | target  |
| ------------------------------- | ------- | -------------- | ------- |
| **Combined (deliverable)**      | 0.0673  | **0.0035**     | `<0.05` |
| OA-only (held-out, trustworthy) | 0.0706  | 0.0067         | —       |
| corpus-only (in-domain)         | 0.0659  | 0.0061         | —       |

MCE (bins n≥20) 0.2891 → 0.1829 · Brier 0.0340 → 0.0270 · n_fit=26043 n_eval=6510 spans.

> MCE is reported over bins with ≥20 samples. The model is confident — ~94% of held-out spans sit in [0.93, 1.0] — so equal-width bins below ~0.7 hold a handful of samples each and their all-bins max gap is single-sample noise, not a calibration failure. ECE (sample-weighted) is the headline; it weights each bin by its mass.

## Reliability (held-out eval, raw confidence)

| confidence bin | n    | mean conf | accuracy | gap   |
| -------------- | ---- | --------- | -------- | ----- |
| [0.13, 0.20)   | 1    | 0.155     | 1.000    | 0.845 |
| [0.20, 0.27)   | 2    | 0.217     | 1.000    | 0.783 |
| [0.27, 0.33)   | 16   | 0.308     | 0.500    | 0.192 |
| [0.33, 0.40)   | 20   | 0.370     | 0.500    | 0.130 |
| [0.40, 0.47)   | 26   | 0.432     | 0.615    | 0.183 |
| [0.47, 0.53)   | 49   | 0.500     | 0.592    | 0.092 |
| [0.53, 0.60)   | 59   | 0.568     | 0.831    | 0.263 |
| [0.60, 0.67)   | 70   | 0.639     | 0.929    | 0.289 |
| [0.67, 0.73)   | 107  | 0.700     | 0.897    | 0.197 |
| [0.73, 0.80)   | 227  | 0.770     | 0.982    | 0.212 |
| [0.80, 0.87)   | 464  | 0.841     | 0.963    | 0.122 |
| [0.87, 0.93)   | 2373 | 0.912     | 0.974    | 0.062 |
| [0.93, 1.00)   | 3096 | 0.950     | 0.986    | 0.037 |

## Reliability (held-out eval, calibrated confidence)

| confidence bin | n    | mean cal | accuracy | gap   |
| -------------- | ---- | -------- | -------- | ----- |
| [0.00, 0.07)   | 1    | 0.046    | 1.000    | 0.954 |
| [0.33, 0.40)   | 6    | 0.348    | 0.667    | 0.319 |
| [0.40, 0.47)   | 32   | 0.425    | 0.500    | 0.075 |
| [0.47, 0.53)   | 14   | 0.521    | 0.571    | 0.051 |
| [0.67, 0.73)   | 10   | 0.684    | 0.800    | 0.116 |
| [0.73, 0.80)   | 51   | 0.751    | 0.569    | 0.183 |
| [0.80, 0.87)   | 116  | 0.841    | 0.879    | 0.038 |
| [0.87, 0.93)   | 148  | 0.924    | 0.919    | 0.006 |
| [0.93, 1.00)   | 6132 | 0.980    | 0.980    | 0.000 |

## ECE by locale (held-out eval, raw → calibrated)

| locale |    n | accuracy | ECE raw | ECE calibrated |
| ------ | ---: | -------: | ------: | -------------: |
| NL     |  192 |    0.995 |  0.1786 |         0.0465 |
| DE     |  195 |    0.887 |  0.1111 |         0.0973 |
| US     | 5320 |    0.972 |  0.0684 |         0.0070 |
| FR     |  803 |    0.966 |  0.0594 |         0.0169 |

## ECE by tag (held-out eval, raw → calibrated)

| tag          |    n | accuracy | ECE raw | ECE calibrated |
| ------------ | ---: | -------: | ------: | -------------: |
| venue        |  434 |    0.931 |  0.1138 |         0.0430 |
| postcode     | 1547 |    0.999 |  0.0893 |         0.0227 |
| locality     | 1668 |    0.972 |  0.0759 |         0.0083 |
| region       | 1219 |    0.998 |  0.0639 |         0.0185 |
| street       |  817 |    0.965 |  0.0624 |         0.0180 |
| house_number |  783 |    0.888 |  0.0322 |         0.0821 |

## Abstention curve (calibrated confidence)

Accept spans at or above the threshold; route the rest to review. Precision is the accuracy of the accepted set.

| threshold | coverage (accepted) | precision | reviewed |
| --------- | ------------------: | --------: | -------: |
| 0.50      |               99.4% |    97.20% |     0.6% |
| 0.80      |               98.2% |    97.64% |     1.8% |
| 0.90      |               96.5% |    97.82% |     3.5% |
| 0.95      |               94.2% |    97.96% |     5.8% |
| 0.97      |               73.1% |    98.44% |    26.9% |

> The single global table is fit across all locales/tags, so it under-serves the worst-calibrated subgroups — the per-locale rows show where the one-size table leaves residual error (the OOD locales and rare tags run far higher than the US/FR-dominated global ECE). A per-locale table is the natural next step once the deployed multi-locale model is the calibration target (#368).

## 20-bin lookup table (raw → calibrated)

| bin center | calibrated |
| ---------- | ---------- |
| 0.025      | 0.000      |
| 0.075      | 0.000      |
| 0.125      | 0.000      |
| 0.175      | 0.211      |
| 0.225      | 0.348      |
| 0.275      | 0.348      |
| 0.325      | 0.425      |
| 0.375      | 0.426      |
| 0.425      | 0.521      |
| 0.475      | 0.738      |
| 0.525      | 0.776      |
| 0.575      | 0.840      |
| 0.625      | 0.851      |
| 0.675      | 0.924      |
| 0.725      | 0.925      |
| 0.775      | 0.957      |
| 0.825      | 0.963      |
| 0.875      | 0.969      |
| 0.925      | 0.983      |
| 0.975      | 0.986      |

## How it's wired

The table ships as `data/eval/calibration/isotonic-en-us-v4.0.0.json` and is turned into a `(raw)=>calibrated` function by the OPT-IN decoder calibrator (`core/decoder/calibration.ts` → `createCalibrator`). Default parse output is unchanged (byte-stable); pass the calibrator via `ParseOpts.calibrate` / `BuildTreeOpts.calibrate` to emit calibrated `conf=`. Regenerate with `scripts/eval/{build-calibration-set.py,collect-span-confidences.ts,fit-isotonic-calibration.py}`.
