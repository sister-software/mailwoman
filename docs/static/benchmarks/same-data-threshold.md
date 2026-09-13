# Abstention-threshold curve — same-data-resolver-v1 1.2.0

Re-graded from the frozen results: a selection is withheld when its recorded confidence falls below the
threshold. No resolver is re-run, so the walk is held fixed and the curve is an upper bound on what a
threshold over this signal can buy at the final selection.

**Exploratory, and outside the frozen pre-registration.** Every threshold here was read off results that
were already visible, which is the one thing the registered rule forbids. The decision column below says
what the registered rule WOULD have read at each threshold; it does not re-decide the frozen verdict, and
no threshold earns a claim until it is registered ahead of a panel it has not seen.

28 of 75 of Mailwoman's withheld-gold selections carry the maximum margin, because the
lookup that produced them considered one candidate. No threshold at or below 1 can withhold those.

The baseline reads 45.3% accuracy and 57.0% false selection. 6 of 15 thresholds beat it on both axes at once, from 0.01 (59.5% accuracy, 48.0% false selection) to 0.30 (46.2% accuracy, 33.0% false selection).

## The registered rule, re-read at each dominating threshold

| threshold | pooled margin | exact McNemar p | per-stratum regressions | rule would read |
| --------- | ------------- | --------------- | ----------------------- | --------------- |
| 0.01      | 14.2 points   | 6.910e-6        | none                    | yes             |
| 0.05      | 9.9 points    | 2.829e-3        | none                    | yes             |
| 0.10      | 8.5 points    | 1.069e-2        | none                    | yes             |
| 0.15      | 8.2 points    | 1.412e-2        | none                    | yes             |
| 0.20      | 5.9 points    | 7.553e-2        | none                    | no              |
| 0.30      | 0.8 points    | 8.570e-1        | none                    | no              |

## Curves

**mailwoman**

| threshold | withheld | selections | selection accuracy | wrong-area rate | false-selection rate |
| --------- | -------- | ---------- | ------------------ | --------------- | -------------------- |
| 0.00      | 0        | 383        | 69.7% (246/353)    | 19.2% (59/308)  | 75.0% (75/100)       |
| 0.01      | 107      | 276        | 59.5% (210/353)    | 9.2% (21/228)   | 48.0% (48/100)       |
| 0.05      | 130      | 253        | 55.2% (195/353)    | 6.3% (13/206)   | 47.0% (47/100)       |
| 0.10      | 143      | 240        | 53.8% (190/353)    | 5.1% (10/198)   | 42.0% (42/100)       |
| 0.15      | 149      | 234        | 53.5% (189/353)    | 5.1% (10/197)   | 37.0% (37/100)       |
| 0.20      | 160      | 223        | 51.3% (181/353)    | 5.3% (10/189)   | 34.0% (34/100)       |
| 0.30      | 181      | 202        | 46.2% (163/353)    | 4.1% (7/169)    | 33.0% (33/100)       |
| 0.40      | 208      | 175        | 39.9% (141/353)    | 4.1% (6/146)    | 29.0% (29/100)       |
| 0.50      | 215      | 168        | 38.2% (135/353)    | 4.3% (6/140)    | 28.0% (28/100)       |
| 0.60      | 217      | 166        | 37.7% (133/353)    | 4.3% (6/138)    | 28.0% (28/100)       |
| 0.70      | 221      | 162        | 36.5% (129/353)    | 4.5% (6/134)    | 28.0% (28/100)       |
| 0.80      | 221      | 162        | 36.5% (129/353)    | 4.5% (6/134)    | 28.0% (28/100)       |
| 0.90      | 221      | 162        | 36.5% (129/353)    | 4.5% (6/134)    | 28.0% (28/100)       |
| 0.99      | 221      | 162        | 36.5% (129/353)    | 4.5% (6/134)    | 28.0% (28/100)       |
| 1.00      | 221      | 162        | 36.5% (129/353)    | 4.5% (6/134)    | 28.0% (28/100)       |

**baseline**

| threshold | withheld | selections | selection accuracy | wrong-area rate | false-selection rate |
| --------- | -------- | ---------- | ------------------ | --------------- | -------------------- |
| 0.00      | 0        | 304        | 45.3% (160/353)    | 30.4% (75/247)  | 57.0% (57/100)       |
| 0.01      | 0        | 304        | 45.3% (160/353)    | 30.4% (75/247)  | 57.0% (57/100)       |
| 0.05      | 0        | 304        | 45.3% (160/353)    | 30.4% (75/247)  | 57.0% (57/100)       |
| 0.10      | 0        | 304        | 45.3% (160/353)    | 30.4% (75/247)  | 57.0% (57/100)       |
| 0.15      | 7        | 297        | 44.8% (158/353)    | 30.5% (74/243)  | 54.0% (54/100)       |
| 0.20      | 7        | 297        | 44.8% (158/353)    | 30.5% (74/243)  | 54.0% (54/100)       |
| 0.30      | 7        | 297        | 44.8% (158/353)    | 30.5% (74/243)  | 54.0% (54/100)       |
| 0.40      | 7        | 297        | 44.8% (158/353)    | 30.5% (74/243)  | 54.0% (54/100)       |
| 0.50      | 7        | 297        | 44.8% (158/353)    | 30.5% (74/243)  | 54.0% (54/100)       |
| 0.60      | 7        | 297        | 44.8% (158/353)    | 30.5% (74/243)  | 54.0% (54/100)       |
| 0.70      | 280      | 24         | 3.7% (13/353)      | 41.7% (10/24)   | 0.0% (0/100)         |
| 0.80      | 280      | 24         | 3.7% (13/353)      | 41.7% (10/24)   | 0.0% (0/100)         |
| 0.90      | 304      | 0          | 0.0% (0/353)       | unmeasured      | 0.0% (0/100)         |
| 0.99      | 304      | 0          | 0.0% (0/353)       | unmeasured      | 0.0% (0/100)         |
| 1.00      | 304      | 0          | 0.0% (0/353)       | unmeasured      | 0.0% (0/100)         |

**ablation**

| threshold | withheld | selections | selection accuracy | wrong-area rate | false-selection rate |
| --------- | -------- | ---------- | ------------------ | --------------- | -------------------- |
| 0.00      | 0        | 314        | 59.2% (209/353)    | 15.2% (39/257)  | 57.0% (57/100)       |
| 0.01      | 88       | 226        | 49.9% (176/353)    | 6.3% (12/191)   | 35.0% (35/100)       |
| 0.05      | 113      | 201        | 45.0% (159/353)    | 4.8% (8/167)    | 34.0% (34/100)       |
| 0.10      | 124      | 190        | 43.3% (153/353)    | 3.8% (6/159)    | 31.0% (31/100)       |
| 0.15      | 128      | 186        | 43.1% (152/353)    | 3.8% (6/158)    | 28.0% (28/100)       |
| 0.20      | 136      | 178        | 41.1% (145/353)    | 4.0% (6/151)    | 27.0% (27/100)       |
| 0.30      | 153      | 161        | 36.8% (130/353)    | 3.7% (5/135)    | 26.0% (26/100)       |
| 0.40      | 171      | 143        | 32.6% (115/353)    | 3.4% (4/119)    | 24.0% (24/100)       |
| 0.50      | 177      | 137        | 30.9% (109/353)    | 3.5% (4/113)    | 24.0% (24/100)       |
| 0.60      | 179      | 135        | 30.3% (107/353)    | 3.6% (4/111)    | 24.0% (24/100)       |
| 0.70      | 180      | 134        | 30.0% (106/353)    | 3.6% (4/110)    | 24.0% (24/100)       |
| 0.80      | 180      | 134        | 30.0% (106/353)    | 3.6% (4/110)    | 24.0% (24/100)       |
| 0.90      | 180      | 134        | 30.0% (106/353)    | 3.6% (4/110)    | 24.0% (24/100)       |
| 0.99      | 180      | 134        | 30.0% (106/353)    | 3.6% (4/110)    | 24.0% (24/100)       |
| 1.00      | 180      | 134        | 30.0% (106/353)    | 3.6% (4/110)    | 24.0% (24/100)       |
