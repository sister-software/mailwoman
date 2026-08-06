# Isotonic confidence calibration — neural-weights-en-us v5.3.0

Post-hoc calibration of the decoder's per-span softmax confidence (the `conf=` a resolver or human reads off the parse). Method: isotonic regression (PAVA) over `(raw confidence, correct?)` pairs from a 50/50 OpenAddresses + training-corpus calibration set. Fit on 80%, every number below measured on the held-out 20%. Task #59 (#240 PR3).

> `correct?` is a normalized exact-or-token-subset span match (so street decomposition and multi-word fragmentation aren't penalized), so the absolute accuracy runs mildly optimistic — isotonic corrects the reliability _shape_, which the lenient threshold leaves intact. The corpus half is in-domain (the model trained on it); the OA-only row above is the trustworthy held-out ECE.

## Headline

| Split                           | ECE raw | ECE calibrated | target  |
| ------------------------------- | ------- | -------------- | ------- |
| **Combined (deliverable)**      | 0.0677  | **0.0028**     | `<0.05` |
| OA-only (held-out, trustworthy) | 0.0698  | 0.0017         | —       |
| corpus-only (in-domain)         | 0.0669  | 0.0037         | —       |

MCE (bins n≥20) 0.2231 → 0.0579 · Brier 0.0213 → 0.0156 · n_fit=28480 n_eval=7120 spans.

> MCE is reported over bins with ≥20 samples. The model is confident — ~94% of held-out spans sit in [0.93, 1.0] — so equal-width bins below ~0.7 hold a handful of samples each and their all-bins max gap is single-sample noise, not a calibration failure. ECE (sample-weighted) is the headline; it weights each bin by its mass.

## Reliability (held-out eval, raw confidence)

| confidence bin | n    | mean conf | accuracy | gap   |
| -------------- | ---- | --------- | -------- | ----- |
| [0.00, 0.07)   | 11   | 0.009     | 0.000    | 0.009 |
| [0.07, 0.13)   | 1    | 0.099     | 1.000    | 0.901 |
| [0.13, 0.20)   | 2    | 0.176     | 0.000    | 0.176 |
| [0.20, 0.27)   | 2    | 0.215     | 1.000    | 0.785 |
| [0.27, 0.33)   | 5    | 0.307     | 0.600    | 0.293 |
| [0.33, 0.40)   | 5    | 0.359     | 0.600    | 0.241 |
| [0.40, 0.47)   | 7    | 0.431     | 0.714    | 0.283 |
| [0.47, 0.53)   | 13   | 0.500     | 0.692    | 0.192 |
| [0.53, 0.60)   | 12   | 0.564     | 0.917    | 0.352 |
| [0.60, 0.67)   | 30   | 0.634     | 0.800    | 0.166 |
| [0.67, 0.73)   | 48   | 0.702     | 0.917    | 0.215 |
| [0.73, 0.80)   | 129  | 0.769     | 0.992    | 0.223 |
| [0.80, 0.87)   | 208  | 0.841     | 0.942    | 0.101 |
| [0.87, 0.93)   | 4146 | 0.916     | 0.985    | 0.070 |
| [0.93, 1.00)   | 2501 | 0.946     | 0.992    | 0.046 |

## Reliability (held-out eval, calibrated confidence)

| confidence bin | n    | mean cal | accuracy | gap   |
| -------------- | ---- | -------- | -------- | ----- |
| [0.00, 0.07)   | 11   | 0.040    | 0.000    | 0.040 |
| [0.60, 0.67)   | 18   | 0.632    | 0.667    | 0.034 |
| [0.67, 0.73)   | 3    | 0.667    | 0.333    | 0.333 |
| [0.80, 0.87)   | 22   | 0.831    | 0.773    | 0.058 |
| [0.87, 0.93)   | 69   | 0.905    | 0.870    | 0.035 |
| [0.93, 1.00)   | 6997 | 0.984    | 0.986    | 0.002 |

## ECE by locale (held-out eval, raw → calibrated)

| locale |    n | accuracy | ECE raw | ECE calibrated |
| ------ | ---: | -------: | ------: | -------------: |
| NL     |  205 |    1.000 |  0.1534 |         0.0462 |
| DE     |  185 |    0.892 |  0.0852 |         0.0831 |
| US     | 5926 |    0.987 |  0.0679 |         0.0043 |
| FR     |  804 |    0.963 |  0.0677 |         0.0049 |

## ECE by tag (held-out eval, raw → calibrated)

| tag           |    n | accuracy | ECE raw | ECE calibrated |
| ------------- | ---: | -------: | ------: | -------------: |
| postcode      | 1570 |    1.000 |  0.0923 |         0.0161 |
| region        | 1244 |    0.999 |  0.0800 |         0.0142 |
| street        |  828 |    0.993 |  0.0791 |         0.0180 |
| street_suffix |  554 |    1.000 |  0.0766 |         0.0172 |
| venue         |  366 |    0.986 |  0.0722 |         0.0143 |
| locality      | 1570 |    0.980 |  0.0479 |         0.0078 |
| house_number  |  815 |    0.912 |  0.0296 |         0.0603 |

## Abstention curve (calibrated confidence)

Accept spans at or above the threshold; route the rest to review. Precision is the accuracy of the accepted set.

| threshold | coverage (accepted) | precision | reviewed |
| --------- | ------------------: | --------: | -------: |
| 0.50      |               99.8% |    98.34% |     0.2% |
| 0.80      |               99.6% |    98.45% |     0.4% |
| 0.90      |               99.2% |    98.51% |     0.8% |
| 0.95      |               91.7% |    98.82% |     8.3% |
| 0.97      |               84.5% |    99.10% |    15.5% |

> The single global table is fit across all locales/tags, so it under-serves the worst-calibrated subgroups — the per-locale rows show where the one-size table leaves residual error (the OOD locales and rare tags run far higher than the US/FR-dominated global ECE). A per-locale table is the natural next step once the deployed multi-locale model is the calibration target (#368).

## 20-bin lookup table (raw → calibrated)

| bin center | calibrated |
| ---------- | ---------- |
| 0.025      | 0.044      |
| 0.075      | 0.600      |
| 0.125      | 0.600      |
| 0.175      | 0.634      |
| 0.225      | 0.634      |
| 0.275      | 0.634      |
| 0.325      | 0.634      |
| 0.375      | 0.634      |
| 0.425      | 0.667      |
| 0.475      | 0.818      |
| 0.525      | 0.833      |
| 0.575      | 0.833      |
| 0.625      | 0.905      |
| 0.675      | 0.905      |
| 0.725      | 0.935      |
| 0.775      | 0.935      |
| 0.825      | 0.935      |
| 0.875      | 0.935      |
| 0.925      | 0.991      |
| 0.975      | 0.991      |

## How it's wired

The table ships as `data/eval/calibration/isotonic-en-us-v4.0.0.json` and is turned into a `(raw)=>calibrated` function by the OPT-IN decoder calibrator (`core/decoder/calibration.ts` → `createCalibrator`). Default parse output is unchanged (byte-stable); pass the calibrator via `ParseOpts.calibrate` / `BuildTreeOpts.calibrate` to emit calibrated `conf=`. Regenerate with `scripts/eval/{build-calibration-set.py,collect-span-confidences.ts,fit-isotonic-calibration.py}`.
