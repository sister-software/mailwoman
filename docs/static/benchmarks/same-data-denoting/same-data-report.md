# Same-data resolver benchmark — same-data-resolver-v1-denoting 1.2.0

Withheld-gold rule: `every-denoting-row`. Ruler: `same-data-resolver-v1` 1.2.0.

## Per-stratum and pooled

| stratum                | arm       | n   | errors | selections | abstentions | selection accuracy | wrong-area rate | mechanism coverage |
| ---------------------- | --------- | --- | ------ | ---------- | ----------- | ------------------ | --------------- | ------------------ |
| unambiguous            | mailwoman | 100 | 0      | 89         | 11          | 76.0% (76/100)     | 11.2% (10/89)   | 89.0%              |
| unambiguous            | baseline  | 100 | 0      | 64         | 36          | 44.0% (44/100)     | 29.7% (19/64)   | 100.0%             |
| unambiguous            | ablation  | 100 | 0      | 66         | 34          | 56.0% (56/100)     | 12.1% (8/66)    | 66.0%              |
| homograph_qualified    | mailwoman | 53  | 0      | 48         | 5           | 66.0% (35/53)      | 18.8% (9/48)    | 90.6%              |
| homograph_qualified    | baseline  | 53  | 0      | 48         | 5           | 60.4% (32/53)      | 25.0% (12/48)   | 100.0%             |
| homograph_qualified    | ablation  | 53  | 0      | 48         | 5           | 69.8% (37/53)      | 20.8% (10/48)   | 90.6%              |
| reordered              | mailwoman | 100 | 0      | 71         | 29          | 58.0% (58/100)     | 14.1% (10/71)   | 71.0%              |
| reordered              | baseline  | 100 | 0      | 35         | 65          | 23.0% (23/100)     | 25.7% (9/35)    | 100.0%             |
| reordered              | ablation  | 100 | 0      | 43         | 57          | 32.0% (32/100)     | 18.6% (8/43)    | 52.0%              |
| contradictory_postcode | mailwoman | 100 | 0      | 100        | 0           | 84.0% (84/100)     | 19.0% (19/100)  | 100.0%             |
| contradictory_postcode | baseline  | 100 | 0      | 100        | 0           | 61.0% (61/100)     | 35.0% (35/100)  | 100.0%             |
| contradictory_postcode | ablation  | 100 | 0      | 100        | 0           | 84.0% (84/100)     | 13.0% (13/100)  | 100.0%             |
| gold_absent            | mailwoman | 100 | 0      | 69         | 31          | unmeasured         | unmeasured      | 86.0%              |
| gold_absent            | baseline  | 100 | 0      | 52         | 48          | unmeasured         | unmeasured      | 100.0%             |
| gold_absent            | ablation  | 100 | 0      | 52         | 48          | unmeasured         | unmeasured      | 75.0%              |
| **pooled**             | mailwoman | 453 | 0      | 377        | 76          | 71.7% (253/353)    | 15.6% (48/308)  | 87.0%              |
| **pooled**             | baseline  | 453 | 0      | 299        | 154         | 45.3% (160/353)    | 30.4% (75/247)  | 100.0%             |
| **pooled**             | ablation  | 453 | 0      | 309        | 144         | 59.2% (209/353)    | 15.2% (39/257)  | 75.3%              |

## Abstention, withheld-gold stratum only

| arm       | n   | abstention precision | false-selection rate |
| --------- | --- | -------------------- | -------------------- |
| mailwoman | 100 | 31.0% (31/100)       | 69.0% (69/100)       |
| baseline  | 100 | 48.0% (48/100)       | 52.0% (52/100)       |
| ablation  | 100 | 48.0% (48/100)       | 52.0% (52/100)       |

## Paired comparisons

**Mailwoman vs the registered baseline** — 353 paired rows.

| quantity                      | value               |
| ----------------------------- | ------------------- |
| difference in accuracy        | 26.3 points         |
| 95% paired-bootstrap interval | 21.0 to 31.7 points |
| first arm only correct        | 107                 |
| second arm only correct       | 14                  |
| both correct                  | 146                 |
| neither correct               | 86                  |
| exact McNemar p               | 6.532e-19           |
| bootstrap resamples / seed    | 10000 / 20260913    |

**Mailwoman vs its own ablation** — 353 paired rows.

| quantity                      | value              |
| ----------------------------- | ------------------ |
| difference in accuracy        | 12.5 points        |
| 95% paired-bootstrap interval | 8.8 to 16.4 points |
| first arm only correct        | 48                 |
| second arm only correct       | 4                  |
| both correct                  | 205                |
| neither correct               | 96                 |
| exact McNemar p               | 1.307e-10          |
| bootstrap resamples / seed    | 10000 / 20260913   |

## Calibration

**mailwoman**

| confidence bin | count | accuracy |
| -------------- | ----- | -------- |
| [0.0, 0.2)     | 157   | 42.0%    |
| [0.2, 0.4)     | 47    | 87.2%    |
| [0.4, 0.6)     | 12    | 91.7%    |
| [0.6, 0.8)     | 4     | 100.0%   |
| [0.8, 1.0)     | 157   | 83.4%    |

**baseline**

| confidence bin | count | accuracy   |
| -------------- | ----- | ---------- |
| [0.0, 0.2)     | 7     | 28.6%      |
| [0.2, 0.4)     | 0     | unmeasured |
| [0.4, 0.6)     | 0     | unmeasured |
| [0.6, 0.8)     | 268   | 54.1%      |
| [0.8, 1.0)     | 24    | 54.2%      |

**ablation**

| confidence bin | count | accuracy |
| -------------- | ----- | -------- |
| [0.0, 0.2)     | 137   | 46.7%    |
| [0.2, 0.4)     | 34    | 88.2%    |
| [0.4, 0.6)     | 8     | 100.0%   |
| [0.6, 0.8)     | 1     | 100.0%   |
| [0.8, 1.0)     | 129   | 82.2%    |

## Registered decision

| condition                 | required            | observed                          | met |
| ------------------------- | ------------------- | --------------------------------- | --- |
| pooled margin             | at least 8.0 points | 26.3 points                       | yes |
| exact McNemar             | p at most 0.05      | 6.532e-19                         | yes |
| no per-stratum regression | none                | gold_absent: false-selection rate | no  |

**Verdict: the registered claim does NOT hold.**

## Rows the baseline won and Mailwoman did not

| row                        | query                      | gold                           | baseline picked | mailwoman picked | mailwoman mechanism                             |
| -------------------------- | -------------------------- | ------------------------------ | --------------- | ---------------- | ----------------------------------------------- |
| unambiguous-030            | `Asti`                     | Asti (IT) 101752681            | 101752681       | 85685195         | picked:bare_region bare_race bare_region_repick |
| unambiguous-037            | `Bergamo`                  | Bergamo (IT) 101752723         | 101752723       | 85685249         | picked:bare_region bare_race bare_region_repick |
| homograph_qualified-001    | `Avon, United States`      | Avon (US) 101712943            | 101712943       | 404498451        | picked:ranked                                   |
| homograph_qualified-014    | `Lodi, Italy`              | Lodi (IT) 101769821            | 101769821       | 404469493        | picked:ranked                                   |
| homograph_qualified-021    | `Camas, Spain`             | Camas (ES) 101757459           | 101757459       | 404342789        | picked:none                                     |
| homograph_qualified-028    | `Haverhill, ENG`           | Haverhill (GB) 101854875       | 101854875       | 85950417         | picked:ranked                                   |
| homograph_qualified-043    | `Salisbury, ENG`           | Salisbury (GB) 101852713       | 101852713       | 9000000772740    | picked:ranked                                   |
| homograph_qualified-046    | `Augusta, Italy`           | Augusta (IT) 101805331         | 101805331       | 404466673        | picked:none                                     |
| reordered-024              | `04 Zizhuang`              | Zizhuang (CN) 1226544909       | 1226544909      | 1260380399       | picked:ranked                                   |
| reordered-073              | `12 Cuneo`                 | Cuneo (IT) 101831549           | 101831549       | 404455523        | picked:ranked                                   |
| reordered-094              | `14 Tsuchiura`             | Tsuchiura (JP) 102032097       | 102032097       | 1209874875       | picked:ranked                                   |
| contradictory_postcode-060 | `Hezhou, 230000`           | Hezhou (CN) 102028047          | 102028047       | 1209112735       | picked:ranked                                   |
| contradictory_postcode-071 | `Yamatokōriyama, 490-1401` | Yamatokōriyama (JP) 1344009113 | 1344009113      | 890521495        | picked:ranked                                   |
| contradictory_postcode-089 | `Kagoshima, 490-1401`      | Kagoshima (JP) 102031675       | 102031675       | 102032237        | picked:ranked                                   |
