# R8 — the rest of Great Britain (Scotland, Wales, England)

Campaign R8, 2026-08-02. London landed at R3/R4b and Northern Ireland at R7, both through the
en-GB carrier that already exists. Scotland, Wales and England need no new package either — they
are the same country code, the same artifact, the same gate. This rung finishes GB.

## Survey, and the two data problems it turned up

| region   | raw pairs | already resolving | fresh |
| -------- | --------- | ----------------- | ----- |
| Scotland | 248       | 0                 | 248   |
| Wales    | 3,014     | 127               | 2,887 |
| England  | 11,165    | 1,508             | 9,078 |

Scotland is clean — Edinburgh 117, Glasgow 105, Aberdeen 8, Dundee 4. The other two are not:

1. **579 England rows carry an EMPTY parent.** A pair with no parent cannot fire and cannot be
   audited; they are dropped rather than shipped as dead weight.
2. **1,489 Welsh parents are civil parishes, not post towns** — `Pontypridd Community`,
   `Llanelli Rural`, `Llanddeiniolen Community`. This is the "Cardiff 33" oddity R2 flagged and
   deferred. The register names the parish that way; an address never does. Dropping them would
   discard half of Wales, so the administrative suffix is **stripped** instead, recovering a real
   post town (`Pontypridd Community` → `Pontypridd`). Same shape as R7's `Londonderry / Derry`
   alias handling: the register's naming convention is not the writer's.

After filtering and folding: **12,454 pairs offered, 10,708 distinct additions.**

## Pre-registered bars

This is by far the largest increment the campaign has shipped — 10,708 against the 87 of R7 and 424
of R4b — so the confound board is weighted toward the risk rather than sampled evenly.

- **B-R8.1 (no regression).** Gauntlet + GB cross-check at its new expected total. Bar: **zero
  newly-failing gated cases.**
- **B-R8.2 (venue-confound floor).** A 90-row board: **60 law-1 directional** surfaces (drawn from
  1,023 available) plus 30 single-word surfaces (from 7,469) — the two classes most likely to open a
  venue name. Bar: **≤2%** dependent-locality false positives.
- **B-R8.3 (positive side).** 60 sampled pairs in a real GB address shape. Bar: **≥70%**
  tag-correct.
- **D-R8.4 (disclosure).** State the filtered and stripped counts in the model card, so the artifact's
  composition is auditable rather than a bare total.

## Readings

- **B-R8.1 PASS.** GB index **20,126 → 30,834** (19,209 PPD + 11,625 secondary), CROSS-CHECK PASS,
  gauntlet green.
- **B-R8.2 PASS.** **0/90** false positives (0.0%).
- **B-R8.3 PASS.** 60/60 emit, **60/60 tag-correct (100%)**.
- **D-R8.4** recorded in the en-gb card: 1,545 civil-parish suffixes stripped, 579 empty-parent rows
  dropped, full per-source composition.

Great Britain is now covered end to end: England, Scotland, Wales, Northern Ireland and London.
