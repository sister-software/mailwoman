# Night shift #3 postmortem — 2026-07-24

Drafted during the shift; finalized at hand-off. Window: ~04:09 UTC → hand-off. Grants: merge
authority for green PRs + demo repoint (contingent); "get it all out and released" for the 7.8.0
close-out.

## What shipped

- **v7.8.0 / bundle 6.6.2 fully closed out** — verification run green (all 41 workspaces
  OIDC-tolerated, clients artifacts), published-tarball md5 battery exact (en-nz pair-index
  `673c2789…`, card 6.6.2), and the end-to-end proof off the public registry:
  `"12 Moir Street, Mangawhai, Mangawhai"` → dependent_locality **and** locality both Mangawhai
  (the (x,x) rule live), `"35 Steyne Avenue Plimmerton Porirua"` comma-free → Plimmerton under
  Porirua (anchored path live). Country two is real.
- **The GB postcode-clip fix (#1275 → #1290, merged)** — a 41.5% silent clip rate on gb-golden
  postcode rows, traced to the designed repair pass (`repairPostcodeLabels`) being unreachable:
  no `gb` codex conventions row + the locale head misrouting en-gb. One registry row + a card pin
  (`conventions.mode: "gb"`): postcode-exact 26→83, clips 44→0, phantom region/unit tags gone.
  Battery PASS on all five pre-registered bars, every pair-prior surface byte-identical.
- **Real NZ venue-confound evidence (#1279 closed, #1289 + #1291 merged)** — 202,847-row Overture
  NZ places extract (CDLA-Permissive-2.0, provenance on disk), a 6,500-row real board, both FP
  surfaces measured, and the synthetic interim retired. The anchored floor was corrected the same
  night from 0.862% to the shipped-configuration **1.354%** (the first number rode a borrowed
  anchor cache).
- **Baseline re-anchor (dated, #1292 merged)** — the comma-free GB number (50/69) was measured
  through an en-us-shaped harness cache; production consults `postcode-gb.bin` and the true
  baseline is **55/69, 94.5% tag-correct**. Verified not code drift by identical-artifact reruns.

## Measured, not shipped (morning decisions)

1. **Transition-level pair evidence — the door is open.** β=5 on the (→ B-dependent_locality)
   transition at pair-hit boundaries recovers **13/17** of the comma-free path-fusion misses
   (β=8: 15/17), with zero collateral on the 47 correct rows and 200 venue rows (a naive-check
   false alarm was caught and corrected mid-probe). Comma-free GB would go ~55/69 → ~63-65/69.
   Build proposal awaits your call.
2. **Postcode-fix release vehicle** — #1290 sits on main unreleased. A 7.8.1 patch ships it (the
   card pin means en-gb consumers get the repair only after the next weights-package publish).
3. **Demo repoint (#1278) — correctly not done**: neural-web has no pair-prior wiring (loader nor
   runner); a repoint would be user-invisible. Gap + ~2-session estimate documented, including
   the real design question (single-posture demo vs country-gated priors).

## Also filed / drafted

- **#1287** venue-pair probe (the starved venue head; the FSA register is itself the evidence).
- **#1288** street-pair probe (failure-anatomy-first; index-scale reality check).
- Talk-ending draft (five beats + slide asks) at the session tmp for review — nothing submitted.
- Namesake generalization: falsified earlier the same day (189/189 region tagging — the parse was
  never the problem); the transition-level result is the honest answer to "have we used all the
  gazetteer's clues": there was exactly one more, and it's measured.

## What went well

- The pre-registered-battery habit caught two measurement-context errors _the same night it made
  them_ — the borrowed-anchor-cache FP and the en-us-shaped-cache baseline. Both corrected with
  dated notes, neither buried. The lesson, now twice-burned: **measure in the shipped
  configuration** (the standing evals-measure-the-user's-path rule, sharpened to harness caches).
- The diagnosis-before-fix rule turned a ship-verification footnote (one clipped postcode) into
  the night's highest-value fix — 41.5% of GB postcode rows were silently wrong and nobody knew.
- Agent fan-out stayed disciplined: every builder in an isolated worktree, every graded claim
  through the pre-registered bars, every STOP honored (the venue-data agent stopped at the fetch
  boundary and asked).

## What could've gone better

- A stale `cd` sent a batch of metadata edits into an agent worktree instead of the main checkout
  (caught immediately, reverted enumerated-only). The absolute-path discipline exists for a
  reason; compound commands after worktree work need it doubly.
- The synthetic NZ venue board's 0/510 looked reassuring and meant nothing — real data found a
  14–22x higher floor. Synthetic stand-ins get one night of life, maximum, before the acquisition
  happens.

## Numbers

| Metric                         | Value                                                              |
| ------------------------------ | ------------------------------------------------------------------ |
| PRs merged                     | 6 (#1289 #1290 #1291 #1292 + the operator's #1285 #1286 close-out) |
| Issues closed                  | #1279 (+ #1275 diagnosed→fixed, #1276 closed previous day)         |
| Issues filed                   | #1287, #1288                                                       |
| Data acquired                  | Overture NZ places, 202,847 rows, CDLA-P-2.0, provenanced          |
| GPU / training                 | 0 / 0                                                              |
| Ships to npm                   | 0 new (7.8.0 verification only — 7.8.1 is a morning call)          |
| Regressions shipped            | 0                                                                  |
| Measurement corrections issued | 2, both same-night, both dated                                     |
