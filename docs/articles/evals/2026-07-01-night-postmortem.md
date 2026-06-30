---
title: Night Shift 2026-07-01 — Issue Cleanup
description: Autonomous backlog-cleanup shift — close resolved/superseded issues, triage the rest, ship the actionable cleanup PRs.
---

# Night Shift 2026-07-01 — Issue Cleanup

Autonomous shift, operator-handed conn. Goal: clean the issue backlog — close what's resolved, triage the rest, ship the small actionable PRs. Non-GPU; ~$0 Modal.

## What shipped

**15 issues closed** (each verified before closing), **7 relabeled**, **2 PRs**.

**Phase 1 — resolved/superseded closes (verified live):**

- **#742** world-coverage gazetteer (97/195 → 244 countries) — #266/#267, deployed `2026-06-30a`.
- **#833** Portland/UK-namesake → joint-consistency (#837 adminCoherence + #838 country_hint). Gauntlet 10/10.
- **#832** "New York, NY" → NYC — wof:hierarchy ancestry backfill (#835/#836). Gauntlet 10/10.
- **#370** parse↔resolve span-rescore — shipped #777/#780. #781 (v2) tracked separately, then closed (lever measured inert).
- **#823** non-US recall coverage residual — verified live: Skopje/Tbilisi/Yerevan/Bitola/Batumi all resolve correctly now (were UNRESOLVED).
- **#735** national US street tier on R2 — verified `street/us/{tx,fl,wa}/{situs,interp}.db` HTTP 206, all 52 slugs hosted.
- **#481** parser hardening bundle — verified shipped: the `#decode` dedup (item 1), repairs-in-both (item 2), ParseOpts export, TLA removal, policy-filter tests all done.

Updated (kept open) **#822** and **#829** with live evidence (below).

**Phase 2 — triage (an agent scanned ~45 issues; every CLOSE spot-verified):**

- Closed **#387** (city-state, superseded by dual-role epic #402), **#330** (FR venue/region premise falsified — n=1), **#426** (Route A conditional — verdict was STAY), **#531** (typo-tolerant FTS shipped 43d0b67c), **#552** (imls subregion fix), **#377** (demo UX components built), **#26** (licensing/share-alike shipped corpus/src/license.ts), **#781** (span-rescore v2 lever measured +0.0pp).
- Relabeled **#444/#435/#456/#564/#727** (`neural`), **#733** (`neural,phase-1`), **#229** (`neural,phase-2`).

**Phase 3 — actionable PRs:**

- **#379** repo housekeeping — PR #849 (undici 6.23→6.24 security patch, merged) + the full dependabot triage logged on the issue (kept open for the serialize-javascript/tar major bumps that need testing).
- **#818** docs recipes — PR #850 (filled the timezone + un-locode recipe stubs, verified usage; the 4 new OpenCage-style recipes remain).
- **#735, #481** — closed as already-shipped (above), not PRs.

## What went well

- **The live geocode probe earned its keep.** Before closing #822/#823 I ran the addresses through the actual harness — and caught a real bug: `Vienna, Austria` still resolves to **Vienna, WV**. That would have been a false close. #823 (off-map coverage) genuinely resolved; #822 (named-foreign-country routing) did not. Verify-before-verdict, one probe, two correct calls.
- **Three issues were already done.** #735, #481, and #823's coverage half were closed by investigation, not by re-doing the work — a stale issue is cheaper to verify than to re-implement.
- **Delegate-then-verify on the bulk triage.** An agent read ~45 issue bodies and cross-referenced the code; I spot-checked every CLOSE recommendation's evidence (the merged PR / commit / file) before acting. Eight confident closes, zero guesses.

## What could've gone better

- **A stale diagnostic nearly misled me.** `coverage-266-validate.ts` pointed at a removed `staging-266/` DB and reported everything UNRESOLVED — including New York, which the gauntlet proves resolves. Caught it because the failure was too broad to be real; re-ran against the live harness instead.
- **The dependabot "safe bumps" were thinner than the issue implied.** The issue cited 44 alerts (1 critical); it's now 24 (no critical). The genuinely-safe bump was a single dev-dep patch (undici); the high-value fixes (serialize-javascript RCE, tar path-traversal) are major bumps on the older lockfile line — risk the operator should test, not an autonomous bump.

## Decisions made autonomously

- **#822 → keep, not close.** The live probe found the named-foreign-country namesake bug still live; closing would have buried it. Sharpened the issue with a clean fix path (a resolver hint on unambiguous foreign country names) instead.
- **Did not force the serialize-javascript/tar major bumps.** A 6→7 forced resolution could break terser/webpack silently; logged for operator testing.
- **Left the #818 multi-service recipe.** It frames Mailwoman against paid APIs — competitive positioning that wants the operator's voice (gracious, not vengeful). Wrote the two factual stubs; left the positioning piece.

## Open questions / next

- **#822** — a foreign-country-name resolver hint (Austria/Australia/Switzerland are unambiguous; Georgia is not). Clean lever, resolver-side, not the GPU placer.
- **#379** — serialize-javascript (RCE) + tar (path-traversal) major bumps need a build+test pass before forcing.
- **#818** — four OpenCage-style recipes remain; the multi-service one wants a voice review.
- **#260 (B3)** — still gated on #249 ODbL counsel sign-off (from the day shift).

## Numbers

| | |
|---|---|
| Issues closed | 15 |
| Issues relabeled | 7 |
| PRs merged | 1 (#849) |
| PRs open | 1 (#850) |
| Modal $ | ~0 |
| GPU | none |
| Regressions shipped | 0 |
| Open issues: before → after | ~45 → 30 |
