# R8 — the rest of Great Britain (Scotland, Wales, England)

Campaign R8 ran on 2026-08-02. London was added at R3/R4b and Northern Ireland at R7, both through
the existing en-GB carrier. Scotland, Wales and England need no new package either, because they
share the country code, the artifact and the cross-check. This rung completes GB.

## Survey, and the two data problems it turned up

| region   | raw pairs | already resolving | fresh |
| -------- | --------- | ----------------- | ----- |
| Scotland | 248       | 0                 | 248   |
| Wales    | 3,014     | 127               | 2,887 |
| England  | 11,165    | 1,508             | 9,078 |

The Scotland data is clean: Edinburgh 117, Glasgow 105, Aberdeen 8, Dundee 4. The other two regions
have problems:

1. **579 England rows have an empty parent.** A pair with no parent can neither fire nor be
   audited, so these rows are dropped.
2. **1,489 Welsh parents are civil parishes rather than post towns**, such as
   `Pontypridd Community`, `Llanelli Rural` and `Llanddeiniolen Community`. R2 flagged this as the
   "Cardiff 33" oddity and deferred it. The register writes the parish name this way, but addresses
   never do. Dropping these rows would discard half of Wales, so the build **strips** the administrative
   suffix to recover a real post town (`Pontypridd Community` → `Pontypridd`). R7's
   `Londonderry / Derry` alias handling solved the same kind of problem, where the register's naming
   convention differs from how people write addresses.

After filtering and folding, the survey offers **12,454 pairs, of which 10,708 are distinct
additions.**

## Pre-registered bars

This is by far the largest increment the campaign has shipped (10,708 pairs, against 87 for R7 and
424 for R4b). The confound board is therefore weighted toward the riskiest surfaces rather than
sampled evenly.

- **B-R8.1 (no regression).** Run the gauntlet and the GB cross-check at its new expected total.
  Bar: **zero newly failing counted cases.**
- **B-R8.2 (venue-confound floor).** Use a 90-row board with **60 law-1 directional** surfaces
  (drawn from 1,023 available) and 30 single-word surfaces (drawn from 7,469). These are the two
  classes most likely to start a venue name. Bar: **≤2%** dependent-locality false positives.
- **B-R8.3 (positive side).** Grade 60 sampled pairs in a real GB address shape. Bar: **≥70%**
  tag-correct.
- **D-R8.4 (disclosure).** The model card states the filtered and stripped counts, so readers can
  audit the artifact's composition instead of seeing only a total.

## Readings

- **B-R8.1 PASS.** The GB index grew from **20,126 to 30,834** pairs (19,209 PPD + 11,625
  secondary). The cross-check passed and the gauntlet is green.
- **B-R8.2 PASS.** **0/90** false positives (0.0%).
- **B-R8.3 PASS.** 60/60 emit, **60/60 tag-correct (100%)**.
- **D-R8.4** recorded in the en-gb card: 1,545 civil-parish suffixes stripped, 579 empty-parent rows
  dropped, full per-source composition.

Great Britain is now covered end to end: England, Scotland, Wales, Northern Ireland and London.
