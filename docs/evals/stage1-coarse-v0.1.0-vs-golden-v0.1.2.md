# v0.1.0 PyTorch checkpoint × golden v0.1.2 (apples-to-apples baseline)

- entries evaluated: **4535**
- full-parse exact match: **0.0088**
- mean token confidence: **0.8587**

## Per-component F1

| tag | precision | recall | f1 | support |
|---|---:|---:|---:|---:|
| country | 0.0135 | 0.1388 | 0.0246 | 245 |
| region | 0.0333 | 0.0409 | 0.0367 | 3205 |
| locality | 0.0677 | 0.0909 | 0.0776 | 3357 |
| dependent_locality | 0.0000 | 0.0000 | 0.0000 | 40 |
| postcode | 1.0000 | 0.0003 | 0.0007 | 2980 |
| subregion | 0.0000 | 0.0000 | 0.0000 | 0 |
| cedex | 0.0000 | 0.0000 | 0.0000 | 1 |

## Calibration (confidence bucket → accuracy)

| bucket | n | accuracy |
|---|---:|---:|
| 0.0–0.1 | 0 | 0.0000 |
| 0.1–0.2 | 1 | 1.0000 |
| 0.2–0.3 | 208 | 0.0913 |
| 0.3–0.4 | 1660 | 0.1084 |
| 0.4–0.5 | 3207 | 0.1366 |
| 0.5–0.6 | 4030 | 0.1846 |
| 0.6–0.7 | 3981 | 0.2042 |
| 0.7–0.8 | 4206 | 0.2183 |
| 0.8–0.9 | 5627 | 0.2472 |
| 0.9–1.0 | 38328 | 0.3366 |
