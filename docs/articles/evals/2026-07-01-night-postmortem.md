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

|                             |          |
| --------------------------- | -------- |
| Issues closed               | 15       |
| Issues relabeled            | 7        |
| PRs merged                  | 1 (#849) |
| PRs open                    | 1 (#850) |
| Modal $                     | ~0       |
| GPU                         | none     |
| Regressions shipped         | 0        |
| Open issues: before → after | ~45 → 30 |

---

# Part 2 — substantive shift (resolver/parser levers)

The cleanup above was the warm-up. After the operator handed the conn (`/night-shift`, ~05:00 UTC), the
plan (`nightshift/2026-06-30-NIGHT-SHIFT-PLAN.md`) drives the rest: A (#822) → D → C → B → E + stretch F–I.

## Operator decision brief (read first)

The full plan shipped (10 PRs) and the backlog is exhaustively triaged. Five threads now wait on a call only
you can make — each with my recommendation:

1. **Lever E — the $20 GPU budget.** _(Corrected after a DeepSeek nudge prompted a deeper dive — my first
   read of this was wrong twice over.)_ The multilocale corpus IS staged AND **the big multilocale win already
   shipped**: v1.9.1-multilocale-3order = **v4.13.0** (PT 52→82%, PL 53→62%, AT +31pp), and v4.16.0 sits on
   that base. So #825 is the _incremental_ push beyond v4.13.0, and its next lever is campaign-gated, not a
   cheap probe: more eval-safe data (#477's recipe, a parity-scorecard decision) or a representation change —
   and **weight is a falsified lever** here (the v1.9.1 postmortem: "only the RENDERING fixes it"). So a
   "resume v194 + upweight the shard, 2k probe" has no falsifiable upside. **Rec: hold the budget; the further
   push is a campaign-strategy + data call, not an overnight GPU run.** (Budget untouched.) Details on #825.
2. **#378 in-browser P95 trace.** The cold-path SLO + budget shipped (#857), but the live P95 — the SLO's
   real gate, which also gates #372 flatbush — needs a Chrome box (the lab has none). **Rec: run the
   chrome-devtools trace against `/demo` from a Chrome-capable machine.**
3. **#861 — server↔demo resolver parity.** The demo's custom `runCascade` doesn't run the shared
   `resolveTree` coherence (#822/#263/#832); population + region-bbox mask the headline cases, the
   explicit-country tail is the gap. **Rec: option B — converge the browser path on the shared `resolveTree`**
   (kills the dual-maintenance permanently) over the quick option-A patch.
4. **#493 — serializer contracts.** The lossless primitive shipped (#859); the serializer surfaces
   (JSON opt-in / XML / tuple shapes) + the demo rendering are the focused session the issue calls for —
   it explicitly wants "operator eyes for the visual," so I stopped at the decision-free primitive.
5. **#379 — `tar` 7.x.** The lone remaining dependabot alert (medium) needs the 7.x major (no 6.x backport);
   pulled only by cacache/node-gyp install tooling. **Rec: a deliberate test-then-bump pass; low real-world
   exposure, not an autonomous force.**

## Lever A — #822 named-foreign-country namesake (PR #852)

`Vienna, Austria` → Vienna **WV**. The plan called for a probe-gated fix (the #265 discipline); the probes
re-shaped it twice before a line of resolver code was written:

- **A0 (parser probe).** Every unambiguous foreign name (`Austria`/`Australia`/`Switzerland`/`Canada`) is
  tagged `country` by the model. `Georgia` tags as `region` in _both_ readings (`Tbilisi, Georgia` and
  `Atlanta, Georgia`) — so it self-disambiguates; the `{Georgia,GE}` skip-set the plan hedged on is dead
  code. Fork (i): the bug is resolver-side.
- **Backend probe (the pivot).** The first read was "coverage gap" — the unscoped `Vienna` lookup returns
  only US Viennas and there's no `country` row for Austria. Querying the DB directly corrected it: Vienna AT
  **does** exist (an exonym-folded row), just _outranked_ by the populous US namesakes; and well-covered WOF
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
assuming the fix broke, I dug in — the resolver was right (−33.87,151.21); my _expected_ value had a dropped
minus sign (`33.8696` not `−33.8696`). My typo, caught by the gate, not a regression.

## Lever D — resolver/parser backlog (#305, #435, #456): triaged, none a clean CPU PR

The diagnostic-first discipline earned its keep — all three are GPU/schema/coverage-dependent, not the
"CPU-doable subset" the plan hoped. The realistic output was a correct re-scope of each (which saves the
next cycle), not three implementations:

- **#305** (proximity-gate the exact-name tier) — the gate needs the postcode anchor's _coordinate_, which
  lives at the resolver layer; the JP/EU postcode shards exist on disk but aren't wired into the default
  geocode path; and `applyPostcodeConsistency` (#370, shipped _after_ #305) already does this proximity test
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

|                                     |     Before |               After |
| ----------------------------------- | ---------: | ------------------: |
| Bare `"City, Country"` resolve-rate |      54.2% | **77.9%** (+23.7pp) |
| +hint ceiling                       |      82.8% |        83.0% (flat) |
| US-namesake misroutes               | 10.5% (53) |           4.3% (22) |
| Bare-supported countries            |        112 |       **157** (+45) |
| Placer-recoverable (#822)           |         57 | **12** (−45 closed) |

**#822 recovered 45 of 57 placer-recoverable countries on CPU** — what the issue (and the drop-in memo)
expected a GPU placer retrain to do. The flat +hint ceiling confirms it closed the placer↔resolver gap
structurally. Artifact: `2026-06-30-822-frontier-gap.md`.

The 18-country residual (exonym + coverage, fails even with a hint) is unchanged — it's the parallel #826
lever, not #822's job. Updated #826 with the post-fix split (5 exonym / 13 coverage), with the nuance that
**the capitals already resolve — the misses are 2nd/3rd-tier cities** (so the exonym lever's ceiling is the
long tail). Verify-before-verdict fired: my first exonym probe tested the capitals (which resolve) before I
realized the failures were the smaller cities.

## Lever C — #818 recipes (3 of 4 shipped, PR #854)

Wrote three OpenCage-style developer recipes in house voice, each verified against the real API (not the
README-fiction trap): **privacy/coordinate-rounding** (`toGeohash` + decimal rounding, with the
"coarsening is not anonymity" caveat), **batch geocoding** (`POST /api/batch`, input-order results, per-row
error isolation, the cap + concurrency knobs), **display-on-a-map** (`resolveEntities → toGeoJSON →
toMapHTML`, the localhost-CORS `file://` gotcha). `docusaurus build` green. The **multi-service/cost-first**
recipe was left for the operator's voice pass (competitive positioning, gracious-not-vengeful).

## Lever B — #379 deps (PR #855): the "high CVE" framing was stale

Verify-before-verdict on the dependabot alerts: serialize-javascript is no longer flagged (on 6.0.2, patched);
js-yaml is all 4.2.0 (above the vuln range); the one cleanly-safe fix was **http-proxy-middleware 2.0.9 →
2.0.10** (in-major patch, dev-server-only) — shipped. The remaining `tar` alert needs the **7.x major** (no
6.x backport), pulled only by cacache/node-gyp install tooling — left for the operator, not an autonomous force.

## Lever I — #480 reproducibility (PR #856): #4 shipped, the rest already done

Most of #480 was already shipped (verify-before-verdict again): REPRODUCIBILITY.md, the strict shard
resolution + `test_shard_paths.py` (deliverable 2), the quantize value_info/opset docstring. The open
deliverable I closed is **#4 — a toolchain pin-consistency verifier** (`verify_toolchain.py`): asserts the
export/quant pins agree across pyproject ↔ the Modal image ↔ the export opset (the exact drift that broke
mobile-Safari int8 in 2026-06-09), wired into `lint:python` + a 3-test pytest. Deliverables 3 (curriculum
stamping) + 5 (snapshot publishing) stay open — both touch the train loop / release machinery.

## Lever H — #378 WASM cold-path SLO (committed artifact)

Couldn't run the live browser trace (**no Chrome on the lab box**), so delivered the measurable half: a
cold-path budget from real artifact sizes (29 MB int8 model, the 1.3 GB candidate.db byte-range-fetched ~12
cold chunks) + a node-side compute floor (model session-init 126 ms, warm parse 5.7 ms native EP) + a
proposed two-surface SLO (cold-load < 6 s / per-keystroke < 50 ms on a Moto-G-class phone). The numbers
already name the cold bottleneck: **the 29 MB model download**, not compute — so the cold lever is model size

- streaming + CDN, not the SQLite path. The per-keystroke resolve cost (which gates **#372 flatbush**) is the
  one piece still needing the in-browser trace. Artifact: `2026-06-30-378-wasm-cold-path-slo.md`. **#372 is
  explicitly parked** behind that trace (diagnostic-before-fix — don't build the index before the profile).

## Decisions made autonomously (Part 2)

- **Deferred lever E (the $20 GPU budget).** #825's gate is GO, but no multilocale corpus/config is staged —
  the retrain needs _new_ PT/PL/AU data (a pipeline session), and weight-only up-weighting likely falsifies
  (the fr.house_number precedent). Burning the $20 on an uninformative probe is worse than preserving it.
  Flagged for operator override.
- **#822 fix shape:** resolver-side joint-consistency (extend the reconcile) over a forward country pin —
  the operator rejected Pelias-style determinism in #833, and DeepSeek's review concurred. Shipped default-on.
- **Did not force the tar 7.x major bump** — dev-only tooling, no 6.x backport, breakage risk on cacache/node-gyp.

## Backlog triage — the contained CPU work is delivered; verify-before-verdict kept paying

After the plan's levers landed, I worked down the rest of the backlog and kept hitting **already-shipped**
(checked before re-implementing, the cleanup's lesson held all night): #480 deliverable 2 (strict shard
resolution + `test_shard_paths.py`), #480's REPRODUCIBILITY.md, #718's "fix boundary-stress-gate.ts first"
(already routes through the canonical `createScorer` in strict mode), #435 quirk 2 (the v4.16.0 model fixed
the street-prefix drop), and the NPPES dedup yardstick (already measured anchor-on, the
`2026-06-22-nppes-dedup-lever-ladder.md` report — #718's "anchor-off 68.0" concern was resolved by
`loadFromWeights`'s default-on soft-feed). Re-doing any of these would have been wasted motion.

What's genuinely left is **operator-gated or focused-session**, not contained CPU riders:

- **#493** (lossless decomposition) — scoped with a round-trip diagnostic (baseline 97.8% content coverage /
  90.4% fully covered; the dominant lost-content class is **multibyte/accented-character fragmentation**,
  `Hôtel` → `H` + an all-O `ô` + `tel de Ville`, confirmed real — offsets are JS-char-aligned), then
  **shipped the pure primitive** (PR #859): `unknownSpans`/`losslessSegments`/`isLossless` in
  `@mailwoman/core/decoder` — the all-O gaps become typed `unknown` spans, round-trip holds 800/800 real
  parses, byte-stable, no serializer touched. The remaining work (serializer contracts, demo) changes
  consumer contracts → the focused session the issue calls for.
- **#825 / lever E** — _corrected late in the shift (see "DeepSeek nudge" below)_: the big multilocale win
  **already shipped** as v4.13.0 (PT 52→82, PL 53→62); #825 is the incremental push, campaign-gated (more data
  / a representation change — weight is falsified). Budget preserved for that campaign call, not a probe.
- **#372 flatbush** — parked behind the #378 in-browser trace (diagnostic-before-fix); that trace needs Chrome
  (absent on the lab box).
- **#718 remainder, the record-matcher epics (#598/#602/#603/#615), #480 #3/#5** — focused sessions / train-loop.

## Found while verifying #822 reaches users → filed #861 (server↔demo resolver parity)

Checked whether the marquee #822 fix actually shows up in the public demo. It does **not run through** `resolveTree`
— the demo has a custom `runCascade` (postcode→locality→raw + region-bbox + population-first over the httpvfs
`candidate.db`), so **none** of the joint-consistency passes (#822/#263/#267/#832) execute in the browser.
Verify-before-verdict kept this from being an overclaim: the demo's `candidate.db` ranks `Vienna AT` (1.69M) #1
over the 45 US Viennas and bbox-constrains `Portland, ME`/`New York, NY`, so the **headline cases already
resolve correctly via population + bbox**. The real gap is the **explicit-country tail** (the #822 placer-recoverable
45 — non-famous foreign cities where population doesn't surface the right place and there's no region to bbox).
Filed #861 with two options (port the country branch to the cascade, or converge the browser path on the shared
`resolveTree` — the candidate backend already honors `findPlace({country})`). A demo-architecture call for the operator.

## DeepSeek nudge → corrected a real error + shipped the #493 serializer surface

Late in the shift, after I'd settled into "the safe autonomous backlog is exhausted, everything left is gated,"
DeepSeek pushed back: _make full use of the night — the trust was to produce._ It was right, and the re-examination
paid off twice:

- **Corrected a factual error on lever E.** Chasing it down, I found my "corpus not staged, E is corpus-blocked"
  read was wrong both ways: the corpus IS staged, AND the multilocale retrain's big win already shipped (v4.13.0,
  PT 52→82). So E's value is largely banked; the residual is campaign-gated, not a probe. Corrected on #825 +
  the decision brief. (The lesson: "exhausted" deserved the same verify-before-verdict as everything else.)
- **Shipped the #493 serializer surface (PR #864, flagged).** I'd over-deferred the _whole_ serializer wiring as
  "operator-owned"; on a closer look the serializer functions are the established `includeAlternatives` opt-in
  pattern (default-off, byte-stable), only the demo rendering genuinely wants "operator eyes." So `decodeAsJson`/
  `decodeAsTuples` (overloaded — existing callers untouched) / `decodeAsXml` gained an opt-in `includeUnknown`;
  7 tests, decoder suite 105/105. Not self-merged — the native-vs-opt-in + JSON-shape contract calls are flagged
  for review; the demo rendering is left for the focused pass.

The takeaway for the next shift: an over-conservative "it's gated" can be its own unverified verdict. The boundary
(don't ship contract/architecture/budget _decisions_) was right; "don't ship the safe plumbing underneath them"
was too cautious.

## Numbers (Part 2 — final)

_Drafted during the shift; finalized at hand-off. Active window ~05:00–13:39 UTC (~8.5h hands-on of the
~14h conn)._

|                                         |                                                                                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Levers shipped                          | A (#822/#852) + C (#818/#854) + B (#379/#855) + I (#480#4/#856) + #493 primitive (#859) + #493 serializers (#864, flagged) + F+H artifacts (#853, #857)                       |
| Levers triaged/measured                 | D (#305/#435/#456 re-scoped), E (deferred — corrected: v4.13.0 already shipped the multilocale win), F (frontier A/B), H (SLO + cold-path budget), #493 (round-trip baseline) |
| PRs merged                              | 12 (#852–860, #862, #863, #865) · 1 open flagged (#864 #493 serializers)                                                                                                      |
| #822 bare resolve-rate                  | **54.2% → 77.9%** (+23.7pp, CPU, no retrain); 45/57 placer-recoverable countries closed                                                                                       |
| Modal $                                 | ~0 (E deferred, budget preserved)                                                                                                                                             |
| GPU                                     | none                                                                                                                                                                          |
| NaN / CI failures on main / regressions | 0 / 0 / 0                                                                                                                                                                     |
| Issues advanced                         | #822 **closed**, #861 **filed**; #305/#379/#435/#456/#480/#493/#818/#825/#826 updated                                                                                         |

## Open / next (the morning decisions)

The decision brief at the top of Part 2 is the authoritative list; the forks for the morning:

- **#864** — review the `unknown` serializer contract (native-vs-opt-in, JSON mix-vs-nest), then merge. The
  #493 parse-API wrappers + demo rendering are the follow-on (they depend on #864's types).
- **Lever E / $20** — held. The multilocale lift is banked (v4.13.0); the further push is a campaign-strategy
  - data call (#477 recipe), not an overnight probe. Budget untouched.
- **#861** — port the country branch to the demo cascade (quick) vs converge on the shared `resolveTree`
  (principled). My rec: converge.
- **#378** — the in-browser P95 trace needs a Chrome-capable machine (gates #372).
- **#379** — `tar` 7.x dev-tooling bump wants a deliberate test pass.
