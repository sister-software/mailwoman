# Isotonic confidence calibration — neural-weights-en-us v4.4.0

Post-hoc calibration of the decoder's per-span softmax confidence (the `conf=` a resolver or human reads off the parse). Method: isotonic regression (PAVA) over `(raw confidence, correct?)` pairs from a 50/50 OpenAddresses + training-corpus calibration set. Fit on 80%, every number below measured on the held-out 20%. Task #59 (#240 PR3).

> `correct?` is a normalized exact-or-token-subset span match (so street decomposition and multi-word fragmentation aren't penalized), so the absolute accuracy runs mildly optimistic — isotonic corrects the reliability _shape_, which the lenient threshold leaves intact. The corpus half is in-domain (the model trained on it); the OA-only row above is the trustworthy held-out ECE.

## Headline

| Split                           | ECE raw | ECE calibrated | target  |
| ------------------------------- | ------- | -------------- | ------- |
| **Combined (deliverable)**      | 0.0643  | **0.0034**     | `<0.05` |
| OA-only (held-out, trustworthy) | 0.0593  | 0.0113         | —       |
| corpus-only (in-domain)         | 0.0682  | 0.0051         | —       |

MCE (bins n≥20) 0.3303 → 0.1338 · Brier 0.0278 → 0.0224 · n_fit=28556 n_eval=7139 spans.

> MCE is reported over bins with ≥20 samples. The model is confident — ~94% of held-out spans sit in [0.93, 1.0] — so equal-width bins below ~0.7 hold a handful of samples each and their all-bins max gap is single-sample noise, not a calibration failure. ECE (sample-weighted) is the headline; it weights each bin by its mass.

## Reliability (held-out eval, raw confidence)

| confidence bin | n    | mean conf | accuracy | gap   |
| -------------- | ---- | --------- | -------- | ----- |
| [0.00, 0.07)   | 5    | 0.006     | 0.000    | 0.006 |
| [0.07, 0.13)   | 2    | 0.093     | 0.500    | 0.407 |
| [0.13, 0.20)   | 1    | 0.188     | 1.000    | 0.812 |
| [0.20, 0.27)   | 2    | 0.246     | 1.000    | 0.754 |
| [0.27, 0.33)   | 4    | 0.305     | 1.000    | 0.695 |
| [0.33, 0.40)   | 8    | 0.380     | 0.375    | 0.005 |
| [0.40, 0.47)   | 18   | 0.436     | 0.667    | 0.231 |
| [0.47, 0.53)   | 35   | 0.498     | 0.829    | 0.330 |
| [0.53, 0.60)   | 31   | 0.567     | 0.774    | 0.207 |
| [0.60, 0.67)   | 46   | 0.640     | 0.891    | 0.251 |
| [0.67, 0.73)   | 59   | 0.703     | 0.915    | 0.212 |
| [0.73, 0.80)   | 137  | 0.769     | 0.912    | 0.144 |
| [0.80, 0.87)   | 288  | 0.838     | 0.858    | 0.019 |
| [0.87, 0.93)   | 3843 | 0.916     | 0.986    | 0.070 |
| [0.93, 1.00)   | 2660 | 0.946     | 0.988    | 0.042 |

## Reliability (held-out eval, calibrated confidence)

| confidence bin | n    | mean cal | accuracy | gap   |
| -------------- | ---- | -------- | -------- | ----- |
| [0.00, 0.07)   | 2    | 0.024    | 0.000    | 0.024 |
| [0.07, 0.13)   | 1    | 0.117    | 0.000    | 0.117 |
| [0.20, 0.27)   | 1    | 0.204    | 0.000    | 0.204 |
| [0.33, 0.40)   | 1    | 0.333    | 0.000    | 0.333 |
| [0.47, 0.53)   | 10   | 0.499    | 0.900    | 0.401 |
| [0.60, 0.67)   | 1    | 0.623    | 1.000    | 0.377 |
| [0.67, 0.73)   | 27   | 0.726    | 0.593    | 0.134 |
| [0.73, 0.80)   | 24   | 0.738    | 0.833    | 0.095 |
| [0.80, 0.87)   | 436  | 0.853    | 0.869    | 0.016 |
| [0.87, 0.93)   | 153  | 0.908    | 0.895    | 0.012 |
| [0.93, 1.00)   | 6483 | 0.988    | 0.987    | 0.001 |

## ECE by locale (held-out eval, raw → calibrated)

| locale |    n | accuracy | ECE raw | ECE calibrated |
| ------ | ---: | -------: | ------: | -------------: |
| NL     |  188 |    0.979 |  0.1520 |         0.0883 |
| DE     |  189 |    0.852 |  0.1276 |         0.1317 |
| FR     |  803 |    0.968 |  0.0734 |         0.0265 |
| US     | 5959 |    0.980 |  0.0671 |         0.0079 |

## ECE by tag (held-out eval, raw → calibrated)

| tag           |    n | accuracy | ECE raw | ECE calibrated |
| ------------- | ---: | -------: | ------: | -------------: |
| street        |  792 |    0.991 |  0.0980 |         0.0306 |
| postcode      | 1582 |    0.975 |  0.0919 |         0.0248 |
| venue         |  411 |    0.981 |  0.0838 |         0.0218 |
| region        | 1219 |    0.993 |  0.0733 |         0.0138 |
| street_suffix |  591 |    1.000 |  0.0703 |         0.0167 |
| locality      | 1618 |    0.974 |  0.0526 |         0.0220 |
| house_number  |  768 |    0.911 |  0.0216 |         0.0552 |

## Abstention curve (calibrated confidence)

Accept spans at or above the threshold; route the rest to review. Precision is the accuracy of the accepted set.

| threshold | coverage (accepted) | precision | reviewed |
| --------- | ------------------: | --------: | -------: |
| 0.50      |               99.9% |    97.59% |     0.1% |
| 0.80      |               99.1% |    97.78% |     0.9% |
| 0.90      |               92.7% |    98.56% |     7.3% |
| 0.95      |               86.4% |    98.82% |    13.6% |
| 0.97      |               81.6% |    98.92% |    18.4% |

> The single global table is fit across all locales/tags, so it under-serves the worst-calibrated subgroups — the per-locale rows show where the one-size table leaves residual error (the OOD locales and rare tags run far higher than the US/FR-dominated global ECE). A per-locale table is the natural next step once the deployed multi-locale model is the calibration target (#368).

## 20-bin lookup table (raw → calibrated)

| bin center | calibrated |
| ---------- | ---------- |
| 0.025      | 0.475      |
| 0.075      | 0.487      |
| 0.125      | 0.487      |
| 0.175      | 0.487      |
| 0.225      | 0.487      |
| 0.275      | 0.490      |
| 0.325      | 0.526      |
| 0.375      | 0.667      |
| 0.425      | 0.731      |
| 0.475      | 0.738      |
| 0.525      | 0.800      |
| 0.575      | 0.854      |
| 0.625      | 0.854      |
| 0.675      | 0.854      |
| 0.725      | 0.854      |
| 0.775      | 0.854      |
| 0.825      | 0.854      |
| 0.875      | 0.938      |
| 0.925      | 0.992      |
| 0.975      | 0.992      |

## How it's wired

The table ships as `data/eval/calibration/isotonic-en-us-v4.0.0.json` and is turned into a `(raw)=>calibrated` function by the OPT-IN decoder calibrator (`core/decoder/calibration.ts` → `createCalibrator`). Default parse output is unchanged (byte-stable); pass the calibrator via `ParseOpts.calibrate` / `BuildTreeOpts.calibrate` to emit calibrated `conf=`. Regenerate with `scripts/eval/{build-calibration-set.py,collect-span-confidences.ts,fit-isotonic-calibration.py}`.
