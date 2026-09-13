# The shipped knob, replayed

`ResolveOpts.minWinningScore` compares against the candidate backend's score, which is a log-population
rank. It is a PROMINENCE floor, not a confidence floor: raising it withholds small places rather than
unsupported ones. Replayed against the frozen fixture, so a walk that asks a question the recording never
answered is counted in `errors` and excluded from every rate — never read as an abstention.

**Read the errors column before the rates.** A floor above 0 makes the walk refuse a node, and the
questions it asks afterwards then differ from the ones the recording answered. Those rows leave the
denominator, so selection accuracy at a raised floor is measured over fewer rows than at 0 and the two
are not comparable. The false-selection column is, because its 100 withheld-gold rows all survive.

| minWinningScore | errors | selections | selection accuracy | wrong-area rate | false-selection rate |
| --------------- | ------ | ---------- | ------------------ | --------------- | -------------------- |
| 0.0             | 0      | 383        | 69.7% (246/353)    | 19.2% (59/308)  | 75.0% (75/100)       |
| 1.0             | 31     | 351        | 73.3% (236/322)    | 10.8% (30/277)  | 74.0% (74/100)       |
| 2.0             | 32     | 350        | 73.2% (235/321)    | 10.9% (30/276)  | 74.0% (74/100)       |
| 3.0             | 34     | 348        | 73.4% (234/319)    | 10.6% (29/274)  | 74.0% (74/100)       |
| 4.0             | 35     | 347        | 73.6% (234/318)    | 10.3% (28/273)  | 74.0% (74/100)       |
| 5.0             | 112    | 270        | 68.0% (164/241)    | 12.8% (25/196)  | 74.0% (74/100)       |
