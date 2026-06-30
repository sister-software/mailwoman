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

## Numbers (Part 1 — cleanup)

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

---

# Part 2 — substantive shift (resolver/parser levers)

The cleanup above was the warm-up. After the operator handed the conn (`/night-shift`, ~05:00 UTC), the
plan (`nightshift/2026-06-30-NIGHT-SHIFT-PLAN.md`) drives the rest: A (#822) → D → C → B → E + stretch F–I.

## Lever A — #822 named-foreign-country namesake (PR #852)

`Vienna, Austria` → Vienna **WV**. The plan called for a probe-gated fix (the #265 discipline); the probes
re-shaped it twice before a line of resolver code was written:

- **A0 (parser probe).** Every unambiguous foreign name (`Austria`/`Australia`/`Switzerland`/`Canada`) is
  tagged `country` by the model. `Georgia` tags as `region` in *both* readings (`Tbilisi, Georgia` and
  `Atlanta, Georgia`) — so it self-disambiguates; the `{Georgia,GE}` skip-set the plan hedged on is dead
  code. Fork (i): the bug is resolver-side.
- **Backend probe (the pivot).** The first read was "coverage gap" — the unscoped `Vienna` lookup returns
  only US Viennas and there's no `country` row for Austria. Querying the DB directly corrected it: Vienna AT
  **does** exist (an exonym-folded row), just *outranked* by the populous US namesakes; and well-covered WOF
  countries carry no `country`-placetype row (only the #267 gap countries do), so the re-pick must filter by
  the `country` ISO **column**, not a `parentId` descendant scope.
- **Salvage-first.** `@mailwoman/codex/country` already carries the ISO-3166 base + address surface forms
  (`matchCountry`, salvaged from isp-nexus). No new table written.

The fix (`applyExplicitCountryCoherence` in `resolve.ts`) is the joint-consistency family's inverse trigger:
fires when the explicit country is the locality's nearest admin context (region-guarded), regardless of the
locality's resolution state (so it pre-empts the span-rescore back-fill), and re-picks the locality to its
same-named in-country place via `matchCountry` → `findPlace({ country })`. No list, no pin — the country
code is a normalization of the model's own `country` emission.

**Result:** Vienna/Sydney/Toronto/Zurich all land in-country; Tbilisi/GE, Portland/Augusta ME→Maine,
Springfield IL, NYC, Paris all held. Gauntlet PASS (regression 15/15 with 5 new anti-rot guards). PR #852,
default-on, awaiting CI.

**verify-before-verdict fired (again):** the first gauntlet run failed Sydney "7532km off." Instead of
assuming the fix broke, I dug in — the resolver was right (−33.87,151.21); my *expected* value had a dropped
minus sign (`33.8696` not `−33.8696`). My typo, caught by the gate, not a regression.

## Lever D — resolver/parser backlog (#305, #435, #456): triaged, none a clean CPU PR

The diagnostic-first discipline earned its keep — all three are GPU/schema/coverage-dependent, not the
"CPU-doable subset" the plan hoped. The realistic output was a correct re-scope of each (which saves the
next cycle), not three implementations:

- **#305** (proximity-gate the exact-name tier) — the gate needs the postcode anchor's *coordinate*, which
  lives at the resolver layer; the JP/EU postcode shards exist on disk but aren't wired into the default
  geocode path; and `applyPostcodeConsistency` (#370, shipped *after* #305) already does this proximity test
  post-walk but isn't wired into `geocode-core`. Re-scoped to: wire the non-US postcode shards, then fold the
  exact-tier demote into the existing #370 pass — no second gate on the hot per-keystroke path.
- **#435** (number-after-street mis-tag) — re-probed the shipped model: **quirk 2 (street-prefix dropped) is
  FIXED** by v4.16.0 (`Rue` now tags `street_prefix`); **quirk 1 still broken** (+ a `ß` tokenization split).
  A decode-time relabel would re-classify a token, which #723's repair-discipline forbids → rides the #825
  retrain eval. Narrowed the issue.
- **#456** (unit_designator/unit_id split) — schema change (ComponentTag + BIO + retrain). Infra is ready
  (`codex/us/unit-designator.ts` + `build-unit-shard`); the open fork is `unit`-subsplit vs `locator[]`
  (#295). Assess-only, deferred to the unit-recognition retrain.

## Lever F — quantify the coverage win (the #822 before/after)

Ran `frontier-gap.ts` (the #822 placer-frontier diagnostic itself) before and after the fix, default drop-in
config, 506 cities / 187 countries:

| | Before | After |
|---|---:|---:|
| Bare `"City, Country"` resolve-rate | 54.2% | **77.9%** (+23.7pp) |
| +hint ceiling | 82.8% | 83.0% (flat) |
| US-namesake misroutes | 10.5% (53) | 4.3% (22) |
| Bare-supported countries | 112 | **157** (+45) |
| Placer-recoverable (#822) | 57 | **12** (−45 closed) |

**#822 recovered 45 of 57 placer-recoverable countries on CPU** — what the issue (and the drop-in memo)
expected a GPU placer retrain to do. The flat +hint ceiling confirms it closed the placer↔resolver gap
structurally. Artifact: `2026-06-30-822-frontier-gap.md`.

The 18-country residual (exonym + coverage, fails even with a hint) is unchanged — it's the parallel #826
lever, not #822's job. Updated #826 with the post-fix split (5 exonym / 13 coverage), with the nuance that
**the capitals already resolve — the misses are 2nd/3rd-tier cities** (so the exonym lever's ceiling is the
long tail). Verify-before-verdict fired: my first exonym probe tested the capitals (which resolve) before I
realized the failures were the smaller cities.

## Numbers (Part 2 — running)

| | |
|---|---|
| Levers shipped | A (#822/#852, merged + measured) |
| Levers triaged/measured | D (#305/#435/#456 re-scoped), F (frontier A/B + #826 update) |
| PRs merged | 1 (#852) |
| #822 bare resolve-rate | 54.2% → 77.9% (+23.7pp, CPU, no retrain) |
| Modal $ | ~0 |
| GPU | none |
| Regressions shipped | 0 |
