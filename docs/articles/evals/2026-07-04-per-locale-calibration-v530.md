# Per-locale confidence calibration — en-us v5.3.0 (#368 L2)

A separate isotonic table per locale, vs the single global table. ECE is measured on each locale's held-out split under three regimes: raw softmax, the global table, the locale table.

| locale |    n | accuracy | ECE raw | ECE global-table | ECE locale-table |
| ------ | ---: | -------: | ------: | ---------------: | ---------------: |
| NL     |  199 |    0.995 |  0.1563 |           0.0514 |       **0.0050** |
| DE     |  196 |    0.878 |  0.1017 |           0.0986 |       **0.0166** |
| FR     |  814 |    0.961 |  0.0733 |           0.0087 |       **0.0047** |
| US     | 5910 |    0.986 |  0.0679 |           0.0037 |       **0.0015** |

> Where the locale-table column beats the global-table column, a single global table is leaving calibration error on the table for that locale (the OOD locales especially). A multi-locale model should ship one calibration table per locale, selected by the locale gate.
