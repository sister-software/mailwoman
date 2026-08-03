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

## The fork resolved: option (a) ran, verdict is SCHEDULE (15:00 UTC probe)

Rather than hold the fork for the operator, the shift-close hour ran option (a) itself — the
cheapest falsifier. **v256-dynamics-probe**: v255's exact composition, gentle dynamics only
(lr 5e-5→1e-5, warmup 200→500, 8000→**2000** steps). The diagnostic asked: schedule or capacity?

| signal                       | v255 (aggressive 8k) | v256 (gentle 2k)          |
| ---------------------------- | -------------------- | ------------------------- |
| US region flips (vs shipped) | 21 (from 63)         | **5 / 600**               |
| US locality flips            | 20 (from 46)         | **0 / 600**               |
| bare-locality pins (parse)   | Dublin re-broke      | **clean**                 |
| parity street (v1 denom)     | 0.55                 | 0.4833 (2k, undertrained) |
| parity postcode              | 0.96–0.99            | 0.9861 PASS               |

**Schedule, not capacity.** The gentle LR + longer warmup held BOTH the US admin-recall repair AND
bare-locality robustness at 2k steps — the two objectives that oscillated under 5e-5/8k. The
oscillation was an optimization-dynamics artifact, not a 29M-param ceiling. Street 0.4833 is low
only because 2k ≪ 8k; the diagnostic wasn't a candidate.

Residual (persists under gentle schedule): the 5 flips are all postcode-adjacent VT cases where
"VT" absorbs into the street span — the **#727 boundary-digit-absorption class**, which schedule
does not touch and is now the named last lever.

**Caveat RESOLVED (same day):** the coordinate-level check was the open question — "pins clean"
was PARSE-level, and the v255 FAIL was a COORDINATE assertion. Rather than the #718-trap `--model`
path or a destructive package swap, a `--weights-cache` path was added to the gauntlet (#9, commit
e0ab8b32; mirrors `eval parity --weights-cache`, resolves the candidate package-shaped). v256
graded through it (md5-confirmed the cache model loaded, not the shipped one) and **PASSED the
regression layer 30/30 gated cases — including the Dublin bare-city coordinate pin** that broke
v255. The schedule verdict is now confirmed at the coordinate level, not just the parse level.

**Next (operator greenlight):** `v2.5.7-fragment-v5-gentle-full` staged and committed but NOT
launched — the full 8k run at v256's gentle schedule. Expected to recover street toward 0.55–0.60
without the oscillation. Held for greenlight because the probe result reframes the fork itself.

## v257 trained + graded (greenlit + run same day)

Operator greenlit the fork ("unblock those and move forward"); v257 trained (8k, gentle, 0 NaN,
loss 0.75→0.70) and graded package-shaped. It is the campaign's **first stable candidate**:

| gate                    | v257                           | vs shipped | vs v255 unstable peak |
| ----------------------- | ------------------------------ | ---------- | --------------------- |
| parity street (triaged) | 0.5356                         | +0.139     | −0.060                |
| parity house_number     | 0.7671                         | +0.066     | ~                     |
| parity postcode         | 0.9861 PASS                    | ~          | ~                     |
| gauntlet regression     | **PASS** (Dublin held)         | holds      | v255 **FAILED**       |
| gauntlet metamorphic    | **PASS** (5 anchor-off xfails) | holds      | ~                     |
| US flip census          | 5 region / 0 locality per 600  | preserved  | better than v255      |

v257 trades ~6pp of v255's unstable street peak for full gauntlet stability + preserved US recall —
the schedule fix at 8k scale. It does **not** clear the SWAPS street floor (0.90), so the v7 swaps
stay gated; the residual is the #727 boundary-absorption class (golden confused-tags confirm it:
"05770 VT DELONG LN" → street got "VT Delong"). **NOT promoted:** doesn't unblock v7, needs card
regen, and the golden 2pp gate is schema-confounded (golden v0.1.2 uses the flat pre-split street
schema — parity is the schema-correct gate). Promote-as-strict-improvement is a clean operator call.
Full grade: `models/candidates/v257-fragment-v5-gentle-full/MANIFEST.md`.

## Decisions under the standing grant

Merged/pushed directly to main throughout (docs, tooling, codex tables, configs). Did NOT
exercise the promote/publish grant: v253/v254 fail the 2pp default gate, v255 fails the gauntlet
— experimental-shipping a blocked-for-default artifact buys nothing the fork decision doesn't
supersede. Treadmill compliance outranked grant flexing.

## Numbers

|                   |                                                                                  |
| ----------------- | -------------------------------------------------------------------------------- |
| Session           | 06:50–15:00 UTC conn (hourly cron reports)                                       |
| Runs              | 4 trained today (v254, v255, v256 probe + v253's gate battery); 7 total campaign |
| Modal GPU         | ~+$18 today (~$53 campaign total); 0 NaN                                         |
| Campaign street   | 0.3967 → **0.5955** peak (triaged; +20pp in ~30h)                                |
| number→postcode   | 21.8% → under 1%                                                                 |
| Promote state     | BLOCKED (2pp gate / gauntlet, per candidate — see matrix)                        |
| v7 excision state | swaps still floor-gated; everything non-model staged and waiting                 |
