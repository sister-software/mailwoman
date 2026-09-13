# The shipped knob, replayed

`ResolveOpts.minWinningScore` compares against the candidate backend's score, which is a log-population
rank — a prominence floor rather than a confidence floor. Replayed against the frozen fixture, so a walk
that asks a question the recording never answered is counted in `replay misses` and its row is dropped
from every arm's denominator, never read as an abstention.

Every rate below is measured over the 341 of 453 rows that every arm scored without a
replay miss. The dropped rows are exactly the ones a floor changed most, so the accuracy column understates
how much the floors move; all 100 withheld-gold rows survive every arm, so the false-selection column is
complete.

| arm                                 | replay misses | selection accuracy | wrong-area rate | false-selection rate |
| ----------------------------------- | ------------- | ------------------ | --------------- | -------------------- |
| default                             | 0             | 67.6% (163/241)    | 15.3% (30/196)  | 75.0% (75/100)       |
| minWinningScore 1                   | 31            | 67.6% (163/241)    | 12.8% (25/196)  | 74.0% (74/100)       |
| minWinningScore 2                   | 32            | 67.6% (163/241)    | 12.8% (25/196)  | 74.0% (74/100)       |
| minWinningScore 3                   | 34            | 67.6% (163/241)    | 12.8% (25/196)  | 74.0% (74/100)       |
| minWinningScore 4                   | 35            | 67.6% (163/241)    | 12.8% (25/196)  | 74.0% (74/100)       |
| minWinningScore 5                   | 112           | 68.0% (164/241)    | 12.8% (25/196)  | 74.0% (74/100)       |
| spanRescore off                     | 0             | 51.5% (124/241)    | 13.1% (19/145)  | 57.0% (57/100)       |
| minWinningScore 4 + spanRescore off | 25            | 51.0% (123/241)    | 5.8% (8/138)    | 8.0% (8/100)         |

A floor alone is nearly inert. Paired with `spanRescore: false` it is not, and the reason is that
`applySpanRescore` returns early only when the tree already holds a resolved place: a floor's refusal
leaves an unresolved tree, which is the recovery pass's trigger condition rather than a state it respects.
