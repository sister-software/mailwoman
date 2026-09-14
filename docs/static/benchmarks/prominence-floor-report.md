# Prominence floor — prominence-floor-v1 1.0.0

Gold from FR, DE, GB, JP, 1000 rows across
5 population bands. Every rate is measured over the 1000 of
1000 rows that every arm scored without a replay miss.

**The claim does NOT hold.** No registered floor reduces the false-selection rate by 10 points in every band while costing at most 5 points of selection accuracy.

## The registered rule, per arm

| arm     | smallest false-selection drop, any band | largest accuracy cost, any band | rule met |
| ------- | --------------------------------------- | ------------------------------- | -------- |
| floor_1 | 11.0 points                             | 16.0 points                     | no       |
| floor_2 | 14.0 points                             | 16.0 points                     | no       |
| floor_3 | 20.0 points                             | 49.0 points                     | no       |
| floor_4 | 23.0 points                             | 55.0 points                     | no       |

## Per band and arm

| band          | arm     | replay misses | selection accuracy | wrong-area rate | false-selection rate |
| ------------- | ------- | ------------- | ------------------ | --------------- | -------------------- |
| pop_1_999     | default | 0             | 71.0% (71/100)     | 9.0% (8/89)     | 47.0% (47/100)       |
| pop_1_999     | floor_1 | 0             | 70.0% (70/100)     | 7.0% (6/86)     | 36.0% (36/100)       |
| pop_1_999     | floor_2 | 0             | 69.0% (69/100)     | 6.0% (5/83)     | 33.0% (33/100)       |
| pop_1_999     | floor_3 | 0             | 22.0% (22/100)     | 18.5% (5/27)    | 7.0% (7/100)         |
| pop_1_999     | floor_4 | 0             | 21.0% (21/100)     | 12.5% (3/24)    | 6.0% (6/100)         |
| pop_1k_4999   | default | 0             | 70.0% (70/100)     | 8.1% (7/86)     | 52.0% (52/100)       |
| pop_1k_4999   | floor_1 | 0             | 62.0% (62/100)     | 9.1% (7/77)     | 33.0% (33/100)       |
| pop_1k_4999   | floor_2 | 0             | 62.0% (62/100)     | 9.1% (7/77)     | 33.0% (33/100)       |
| pop_1k_4999   | floor_3 | 0             | 61.0% (61/100)     | 9.2% (7/76)     | 32.0% (32/100)       |
| pop_1k_4999   | floor_4 | 0             | 15.0% (15/100)     | 20.0% (4/20)    | 18.0% (18/100)       |
| pop_5k_14999  | default | 0             | 81.0% (81/100)     | 4.3% (4/94)     | 54.0% (54/100)       |
| pop_5k_14999  | floor_1 | 0             | 65.0% (65/100)     | 3.9% (3/76)     | 19.0% (19/100)       |
| pop_5k_14999  | floor_2 | 0             | 65.0% (65/100)     | 3.9% (3/76)     | 19.0% (19/100)       |
| pop_5k_14999  | floor_3 | 0             | 65.0% (65/100)     | 2.7% (2/75)     | 18.0% (18/100)       |
| pop_5k_14999  | floor_4 | 0             | 34.0% (34/100)     | 2.4% (1/42)     | 16.0% (16/100)       |
| pop_15k_49999 | default | 0             | 65.0% (65/100)     | 18.9% (17/90)   | 62.0% (62/100)       |
| pop_15k_49999 | floor_1 | 0             | 52.0% (52/100)     | 19.4% (14/72)   | 38.0% (38/100)       |
| pop_15k_49999 | floor_2 | 0             | 52.0% (52/100)     | 19.4% (14/72)   | 38.0% (38/100)       |
| pop_15k_49999 | floor_3 | 0             | 52.0% (52/100)     | 18.3% (13/71)   | 37.0% (37/100)       |
| pop_15k_49999 | floor_4 | 0             | 50.0% (50/100)     | 17.6% (12/68)   | 32.0% (32/100)       |
| pop_50k_up    | default | 0             | 19.0% (19/100)     | 70.1% (61/87)   | 72.0% (72/100)       |
| pop_50k_up    | floor_1 | 0             | 18.0% (18/100)     | 66.2% (45/68)   | 49.0% (49/100)       |
| pop_50k_up    | floor_2 | 0             | 18.0% (18/100)     | 65.7% (44/67)   | 49.0% (49/100)       |
| pop_50k_up    | floor_3 | 0             | 18.0% (18/100)     | 65.2% (43/66)   | 49.0% (49/100)       |
| pop_50k_up    | floor_4 | 0             | 18.0% (18/100)     | 64.1% (41/64)   | 49.0% (49/100)       |
