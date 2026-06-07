# Per-locale confidence calibration — en-us v4.0.0 (#368 L2)

A separate isotonic table per locale, vs the single global table. ECE is measured on each locale's held-out split under three regimes: raw softmax, the global table, the locale table.

| locale |    n | accuracy | ECE raw | ECE global-table | ECE locale-table |
| ------ | ---: | -------: | ------: | ---------------: | ---------------: |
| NL     |  201 |    0.985 |  0.1733 |           0.0466 |       **0.0096** |
| DE     |  197 |    0.893 |  0.0932 |           0.0889 |       **0.0411** |
| US     | 5315 |    0.973 |  0.0674 |           0.0044 |       **0.0037** |
| FR     |  796 |    0.966 |  0.0641 |           0.0138 |       **0.0117** |

> Where the locale-table column beats the global-table column, a single global table is leaving calibration error on the table for that locale (the OOD locales especially). A multi-locale model should ship one calibration table per locale, selected by the locale gate.
