# The shipped knob, replayed

`ResolveOpts.minWinningScore` compares against the candidate backend's score, which is a log-population
rank — a prominence floor rather than a confidence floor. Replayed against the frozen fixture, so a walk
that asks a question the recording never answered is counted in `replay misses` and its row is dropped
from every arm's denominator, never read as an abstention.

Every rate below is measured over the 372 of 453 rows that every arm scored without a
replay miss. The dropped rows are exactly the ones a floor changed most, so the accuracy column understates
how much the floors move; all 100 withheld-gold rows survive every arm, so the false-selection column is
complete.

| arm                                 | replay misses | selection accuracy | wrong-area rate | false-selection rate |
| ----------------------------------- | ------------- | ------------------ | --------------- | -------------------- |
| default                             | 0             | 66.9% (182/272)    | 17.2% (39/227)  | 75.0% (75/100)       |
| minWinningScore 1                   | 22            | 65.4% (178/272)    | 11.7% (25/213)  | 43.0% (43/100)       |
| minWinningScore 2                   | 23            | 65.4% (178/272)    | 11.7% (25/213)  | 43.0% (43/100)       |
| minWinningScore 3                   | 25            | 65.4% (178/272)    | 11.3% (24/212)  | 36.0% (36/100)       |
| minWinningScore 4                   | 25            | 65.4% (178/272)    | 10.5% (22/210)  | 26.0% (26/100)       |
| minWinningScore 5                   | 81            | 47.8% (130/272)    | 12.2% (19/156)  | 21.0% (21/100)       |
| spanRescore off                     | 0             | 52.6% (143/272)    | 15.9% (28/176)  | 57.0% (57/100)       |
| minWinningScore 4 + spanRescore off | 25            | 51.1% (139/272)    | 6.9% (11/159)   | 8.0% (8/100)         |

Before #2265, a floor alone was inert: it moved the false-selection rate by one row across the whole
populated range of the scale, because `applySpanRescore` recovers any tree holding no resolved place and a
refusal leaves exactly that — so the recovery re-issued the byte-identical lookup the floor had declined.
The floor now refuses for real, and the remaining gap to `spanRescore: false` is span rescore answering
the rows the floor never reached rather than the ones it refused.

The magnitudes are this panel's, not a setting: every one of its 453 gold entities has population above
15,151 and four of its five strata sit above 50,000, so a floor of 4.0 — population 10,000 — admits every
correct answer here by construction. A panel whose gold all clears a floor cannot measure that floor.
