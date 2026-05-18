# Eval report — step-006000

- entries evaluated: **74**
- full-parse exact match: **0.0000**
- mean token confidence: **0.8653**

## Per-component F1

| tag                | precision | recall |     f1 | support |
| ------------------ | --------: | -----: | -----: | ------: |
| country            |    0.0000 | 0.0000 | 0.0000 |       6 |
| region             |    0.0986 | 0.1111 | 0.1045 |      63 |
| locality           |    0.0423 | 0.0417 | 0.0420 |      72 |
| dependent_locality |    0.0000 | 0.0000 | 0.0000 |       1 |
| postcode           |    0.0000 | 0.0000 | 0.0000 |      65 |
| subregion          |    0.0000 | 0.0000 | 0.0000 |       0 |
| cedex              |    0.0000 | 0.0000 | 0.0000 |       1 |

## Calibration (confidence bucket → accuracy)

| bucket  |   n | accuracy |
| ------- | --: | -------: |
| 0.0–0.1 |   0 |   0.0000 |
| 0.1–0.2 |   0 |   0.0000 |
| 0.2–0.3 |   5 |   0.0000 |
| 0.3–0.4 |  36 |   0.2222 |
| 0.4–0.5 |  56 |   0.2143 |
| 0.5–0.6 |  73 |   0.2055 |
| 0.6–0.7 |  64 |   0.0938 |
| 0.7–0.8 |  94 |   0.2128 |
| 0.8–0.9 |  95 |   0.2316 |
| 0.9–1.0 | 777 |   0.3591 |
