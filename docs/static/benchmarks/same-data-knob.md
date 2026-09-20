# The shipped knob, replayed

`ResolveOpts.minWinningScore` compares against the candidate backend's score, which is a log-population
rank — a prominence floor rather than a confidence floor. Replayed against the frozen fixture, so a walk
that asks a question the recording never answered is counted in `replay misses` and its row is dropped
from every arm's denominator, never read as an abstention.

Every rate below is measured over the 355 of 453 rows that every arm scored without a
replay miss. The dropped rows are exactly the ones a floor changed most, so the accuracy column understates
how much the floors move; all 100 withheld-gold rows survive every arm, so the false-selection column is
complete.

| arm                                 | replay misses | selection accuracy | wrong-area rate | false-selection rate |
| ----------------------------------- | ------------- | ------------------ | --------------- | -------------------- |
| default                             | 17            | 68.3% (177/259)    | 13.1% (28/214)  | 74.0% (71/96)        |
| minWinningScore 1                   | 39            | 66.8% (173/259)    | 8.5% (17/200)   | 41.7% (40/96)        |
| minWinningScore 2                   | 40            | 66.8% (173/259)    | 8.5% (17/200)   | 41.7% (40/96)        |
| minWinningScore 3                   | 42            | 66.8% (173/259)    | 8.0% (16/199)   | 34.4% (33/96)        |
| minWinningScore 4                   | 42            | 66.8% (173/259)    | 7.1% (14/197)   | 22.9% (22/96)        |
| minWinningScore 5                   | 98            | 48.3% (125/259)    | 7.7% (11/143)   | 17.7% (17/96)        |
| spanRescore off                     | 0             | 55.2% (143/259)    | 14.2% (25/176)  | 59.4% (57/96)        |
| minWinningScore 4 + spanRescore off | 25            | 53.7% (139/259)    | 6.9% (11/159)   | 8.3% (8/96)          |
| spanRescore context remainder       | 13            | 68.3% (177/259)    | 13.1% (28/214)  | 71.9% (69/96)        |

Before #2265, a floor alone was inert: it moved the false-selection rate by one row across the whole
populated range of the scale, because `applySpanRescore` recovers any tree holding no resolved place and a
refusal leaves exactly that — so the recovery re-issued the byte-identical lookup the floor had declined.
The floor now refuses for real, and the remaining gap to `spanRescore: false` is span rescore answering
the rows the floor never reached rather than the ones it refused.

The magnitudes are this panel's rather than a setting: every one of its 453 gold entities has population above
15,151 and four of its five strata sit above 50,000, so a floor of 4.0 — population 10,000 — admits every
correct answer here by construction. A panel whose gold all clears a floor cannot measure that floor.
