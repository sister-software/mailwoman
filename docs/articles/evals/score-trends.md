# Per-tag score trends

GENERATED from [`evals/scores-by-version.json`](https://github.com/sister-software/mailwoman/blob/main/evals/scores-by-version.json)
by `scripts/eval/build-score-trends.py` — do not hand-edit; regenerate after each ledger row.

Numbers are per-tag scores as recorded per release (eval sets, channels, and quantization
evolve across eras — adjacent columns are comparable, distant ones directional; the dated
ship-gate docs carry each column's exact conditions). "—" = not measured that release.

## US

| tag                | 0.1.0 | 0.2.0 | 3.0.0 | 4.2.0 | 4.3.0 | 4.4.0 |
| ------------------ | ----: | ----: | ----: | ----: | ----: | ----: |
| micro              |     — |     — |     — |  84.8 |  85.1 |  86.1 |
| street             |     — |     — |  26.6 |  76.2 |  75.5 |  77.9 |
| street_prefix      |     — |     — |     — |  64.9 |  93.6 |  93.6 |
| street_suffix      |     — |     — |     — |  48.8 |  96.6 |  96.6 |
| house_number       |     — |     — |  78.3 |     — |     — |     — |
| locality           |   7.8 |  64.7 |  26.6 |  72.9 |  74.4 |  75.7 |
| region             |   3.7 |  82.9 |  17.6 |  89.1 |  89.1 |  90.3 |
| postcode           |   0.1 |  85.9 |  75.5 |  97.3 |  97.8 |  98.3 |
| country_homograph  |     — |     — |     — |  89.8 |  85.1 |  89.8 |
| unit               |     — |     — |     — |  90.6 |  92.1 |  92.1 |
| po_box_real        |     — |     — |     — |     — |     — |  89.1 |
| intersection_real  |     — |     — |     — |     — |     — |   100 |
| cedex              |     — |     — |     0 |     — |     — |     — |
| country            |   2.5 |     0 |    28 |     — |     — |     — |
| dependent_locality |     — |     — |     0 |     — |     — |     — |
| venue              |     — |     — |  39.4 |     — |     — |     — |

## FR

| tag          | 0.1.0 | 0.2.0 | 3.0.0 | 4.2.0 | 4.3.0 | 4.4.0 |
| ------------ | ----: | ----: | ----: | ----: | ----: | ----: |
| house_number |     — |     — |     — |  94.6 |  97.7 |  97.2 |
| region       |     — |     — |     — |  27.6 |  16.2 |  25.6 |
| postcode     |     — |     — |     — |  99.7 |  99.7 |  99.6 |
| cedex_real   |     — |     — |     — |     — |     — |  96.1 |

## DE

| tag                       | 0.1.0 | 0.2.0 | 3.0.0 | 4.2.0 | 4.3.0 | 4.4.0 |
| ------------------------- | ----: | ----: | ----: | ----: | ----: | ----: |
| native_locality_anchor_on |     — |     — |     — |  90.7 |  90.1 |    91 |
