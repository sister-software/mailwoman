# 2026-07-13 day — the campaign hits its fork: data levers exhausted at the twin↔recall trade

Day session (conn 06:50–15:00 UTC, operator on sponsorship work; standing grant for
promote/merge/publish). Continues the night-1 postmortem. Three more one-variable runs (v254,
v255 + the v253 gates), the gold triage, two codex deliverables, and the treadmill guard's first
firing of the campaign.

## The trade matrix (why iteration stopped)

Gates: parity floors (hn/pc .97, street .90 — the SWAPS bar) on v1 AND triaged gold (33
rules-idiosyncratic tombstones, proposal published as `2026-07-13-parity-gold-triage.md`;
default gate remains v1 until operator ratifies); the pre-publish 2pp error-analysis gate (the
NPM-promote bar); the full gauntlet.

| run             | one variable                        | parity triaged (hn/pc/street) | US recall delta (region/locality) | gauntlet                                   |
| --------------- | ----------------------------------- | ----------------------------- | --------------------------------- | ------------------------------------------ |
| v253 (shard-v3) | +global locality twins              | .74/.99/.52                   | −2.3 / −3.2                       | **PASS**                                   |
| v254 (shard-v4) | +comma-free context, +famous twins  | .76/.99/.588                  | −2.5 / −2.5                       | **PASS**                                   |
| v255 (shard-v5) | +US admin pairs, +directional twins | .78/.96/**.5955**@2k          | flips 63→21 / 46→20 (repaired)    | **FAIL** (Dublin pin re-broke, both ckpts) |

The oscillation — twins fix bare-locality robustness and erode US admin recall; the counterweight
repairs US recall and re-breaks bare-locality — is a capacity/stability constraint at 29M params
under the 5e-5/8k fine-tune idiom, not a shard-composition problem. Per the treadmill guard: no
seventh solo run; the fork goes to the operator (documented on #1102):
(a) dynamics probe (v255 composition, gentler LR/warmup, 2k steps), (b) ship v254 experimental
(the only gauntlet-green candidate; default blocked by the 2pp gate), (c) the #727 span-head arc,
(d) hold for night-2.

## What the day banked besides the fork

- **Gold triage applied** (33 tombstones, dual-number reporting everywhere; triaged street
  denominator 267). Proposal + borderlines-kept documented; operator ratifies any default flip.
- **Flip census tooling** (`us-recall-flip-census.run.ts`) — named both erosion mechanisms
  (region absorbed INTO locality 40/63; exotic-script + directional-prefixed localities dropped
  42/46) and proved the v255 counterweight repaired them.
- **#1100 secondary-address epic: both data deliverables shipped** — Pub-28 C2 extension
  (requires-range flags + matchers; the table itself already existed, salvage-first via subagent)
  and the NEW per-locale level-semantics table (11 lexicons + IMDF ordinals, 40 tests; codex now
  338 tests).
- **#1101 filed + scoped** (punctuation-drop augmentation; whitespace-only measured at 64% of
  parity gold — operator-elevated to first-class, gauntlet `*_undelimited` kinds + metamorphic
  invariant in scope).
- **#1102 filed** (the promote blocker, now carrying the fork).
- Issues #1093/#901 closed with receipts; #444/#376/#456/#996 updated; backlog triaged (59 open,
  categorized).

## Decisions under the standing grant

Merged/pushed directly to main throughout (docs, tooling, codex tables, configs). Did NOT
exercise the promote/publish grant: v253/v254 fail the 2pp default gate, v255 fails the gauntlet
— experimental-shipping a blocked-for-default artifact buys nothing the fork decision doesn't
supersede. Treadmill compliance outranked grant flexing.

## Numbers

|                   |                                                                      |
| ----------------- | -------------------------------------------------------------------- |
| Session           | 06:50–15:00 UTC conn (hourly cron reports)                           |
| Runs              | 3 trained today (v254, v255 + v253's gate battery); 6 total campaign |
| Modal GPU         | ~+$15 today (~$50 campaign total); 0 NaN                             |
| Campaign street   | 0.3967 → **0.5955** peak (triaged; +20pp in ~30h)                    |
| number→postcode   | 21.8% → under 1%                                                     |
| Promote state     | BLOCKED (2pp gate / gauntlet, per candidate — see matrix)            |
| v7 excision state | swaps still floor-gated; everything non-model staged and waiting     |
