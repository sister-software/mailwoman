---
sidebar_position: 5
title: "Distance to done — a whole-project position read, 2026-08-06"
---

# Distance to done — a whole-project position read

**When:** 2026-08-06, the day after v9.0.0 shipped to npm.
**What this is:** one question, answered against the project's own definitions rather than an
invented rubric — _how far is mailwoman from something we can call done?_
**Method:** read the four documents that define done here, pull all 74 open issues, verify every
headline number against its primary artifact rather than the document that cites it, and check the
drop-in parity claims against the workspaces instead of the table that summarizes them.

Three numbers in the brief that opened this review did not survive verification. They are corrected
in place below and collected in [Corrections](#corrections-to-numbers-in-circulation). That is the
tone of the whole document: the receipts are good, and several of the summaries built on top of
them have drifted.

---

## 1. What "done" means here

Four sources define it. They agree more than they conflict, and where they conflict the conflict is
informative.

### 1.1 The contract — epic #488's definition of done

This is the only place the project writes a finish line as a sentence. Verbatim:

> When this list is checked, mailwoman is: a parser that never does worse than v0 (arbitration, by
> construction) and decisively better on real-world input; forward geocoding to street level (point
> lookup + interpolation) in the countries we cover; reverse geocoding; autocomplete; batch + served
> API with observability; an honest, leakage-free eval story in every shipped locale; reproducible
> training; a pocket tier that still installs nothing — and documentation a stranger can onboard
> from. That is the geocoder.

Nine clauses. Seven are shipped. Two are not: _"decisively better on real-world input"_ is measured
against libpostal and the retired v0 rule engine but not against the system that actually competes
(§2.4), and _"an eval story in every shipped locale"_ is where the largest single gap sits (§2.3).

The queue itself has drifted: three items remain unchecked (#473, #375, #294) whose issues were
closed COMPLETED on 2026-08-05 with receipts, and #379 closed 2026-07-06. The board's boxes are
behind its own issue tracker by four rows.

### 1.2 The scope declaration — locale tiers and five standing invariants

`docs/engineering/SCOPE.mdx`, declared 2026-07-02. Tier 1 is **US and FR** and nothing else; tier 2
is fourteen locales with coordinate panels; tier 5 is **JP, resolver-route only, "no parser training
claim."** The invariants that function as gates:

1. Grade the assembled coordinate, never label-F1 alone; full per-tag re-score every 5 promotes or
   on any promote that lowers a floor.
2. The demo is the geocoder. _"A win that doesn't reach the demo is discounted to zero."_
3. Pre-registered gates; falsified changes get reverted, not shipped.
4. Repair retirement — every post-model patch shrinks at each consolidation.
5. Runtime flags are instruments, not homes.

Invariant 1's re-score cadence is **currently unmet** (§2.4). The others hold.

### 1.3 The identity claim

`what-mailwoman-is.mdx`: a **calibrated, retrieval-augmented sequence labeler over a microlanguage**,
coupled to a gazetteer. Four words, each required. Three are demonstrably true today. The fourth
carries a footnote: the isotonic calibrators ship in the weights bundle, but `calibrate` is
**default-OFF** in `ParseOpts` (runtime-flag register, "opt-in at parse, the demo exposes a toggle").
The confidences a default consumer reads are therefore uncalibrated softmax, not the calibrated
probabilities the README promises at line 150 ("when it says `0.88`, it is right about 88% of the
time"). This is a one-line documentation fix or a flag flip with a gate behind it — but as written,
the claim and the default disagree.

### 1.4 The founding objective

The README states the operational form: _"no Elasticsearch and no multi-gigabyte libpostal
install,"_ three wire-compatible drop-ins, ~30 MB model plus a SQLite gazetteer. The north-star
framing carried in project memory — beat Pelias's rules parser without Elasticsearch — has a
measured answer, and it is not yet yes (§2.4).

---

## 2. The scorecard

### 2.1 Model and gate — v9.0.0, model 9.0.0

`mailwoman@9.0.0` is on npm (published 2026-08-06 05:57 UTC), all 48 publishable workspaces in
lockstep. The promotion gate `v9.0.0-base` **PASSES all 18 floors**. Ledger row
`v420-base-anchor-v2-s42-20260806`.

| Metric         | 7.0.0 | 9.0.0    | Floor | Read                           |
| -------------- | ----- | -------- | ----- | ------------------------------ |
| us.postcode    | 95.9  | **98.9** | 93.7  | clear                          |
| us.locality    | 81.0  | **86.1** | 79.6  | clear                          |
| us.region      | 91.5  | **91.6** | 89.4  | clear                          |
| us.street      | 90.5  | **75.2** | 67.7  | instrument changed — see below |
| us.micro       | 89.8  | **87.5** | 82.9  | instrument changed             |
| us.unit_real   | 97.0  | **93.9** | 73.0  | **watch, −3.1 at n=34**        |
| us.po_box_real | 90.9  | **97.0** | 94.3  | clear                          |
| fr.region      | 44.1  | **81.2** | 36.7  | the largest single gain        |
| fr.cedex_real  | 90.5  | **99.8** | 92.4  | clear                          |
| arena.perturb  | 78    | **66**   | 59.9  | **−12, and unnarrated**        |

Two of those rows deserve their own paragraph.

**us.street's −15.3 is an answer-key change, not a capability loss.** Golden v0.1.2 folded a US
street into one span while the corpus splits it; v0.1.3 moves the key onto the corpus convention.
Under the corrected key the candidate reads 75.2 against the 7.0.0 baseline's 71.7 — it leads by
3.5pp. The gate spec argues this at length and re-anchors rather than ratchets. The reasoning is
sound and documented. What matters for a position read is the **absolute** number: street-name span
F1 is **75.2**, and the standing campaign target in the live parity floors is **0.90**.

**arena.perturb 78 → 66 is a real 12-point drop on the perturbation arena, and it appears in the
ledger and nowhere else.** Not in the release row, not in the Run B record, not in the model card.
It clears its floor (59.9) because that floor was ratcheted from an era with n=100 while the arena
now regenerates 398 cases — so the floor held the old bar and the re-cut would have been looser. The
number is defensible. Its absence from every narrative surface is not, and it is the single most
important thing this review found that nobody had written down.

**Live parity gate, 321 fixtures — both floors fail in both arms:**

| Floor        | Baseline | Candidate | Bar      | Verdict        |
| ------------ | -------- | --------- | -------- | -------------- |
| house_number | 0.8288   | 0.9315    | **0.97** | FAIL both arms |
| postcode     | 0.9722   | 0.9722    | 0.97     | PASS           |
| street       | 0.6554   | 0.7116    | **0.90** | FAIL both arms |

The v9.0.0 release row quotes both of these as gains (".83→.93", ".66→.71") without stating that
each remains below its bar. The gate record it links to is titled _"measurement only. No promotion
decision is taken or implied here"_ and its combined gauntlet verdict is **FAIL in both arms**. The
promotion decision was taken separately and deliberately (ROAD_TO_V9 §1, "promotes with conditions,"
operator-ratified) — that is a legitimate call. The release note reads as though the record endorsed
it, and the record says otherwise.

**Run B's own pre-registered sheet: 5 PASS, 1 FAIL (G3 invariance, 4 new violations), 2 MIXED,
1 INCONCLUSIVE, and 5 NOT SCORED.** Five of fourteen bars had no instrument on the host — missing
fixtures, an absent harness, an absent reference. A gate where a third of the bars cannot be
evaluated is a gate with a hole in it, and closing that hole is bounded work (§4).

### 2.2 The gauntlet

Corpus: 115 two-letter country directories, **306 cases**, board id pinned at
`gauntlet-regression@306:ba944d75c9df`.

```
pass                 88
improvement_target  217
known_fail            1
```

**"88/88" is a construction, not a measurement.** The 88 is the count of gating rows after six were
moved out of gating on 2026-08-05/06: four PR/VG/VI territory rows demoted in #1521, and
`de-r9-nippes-koeln` + `us-subvenue-googleplex-building` demoted in #1526. The last _measured_ run in
the repo is #1525's: **92/94 gated, 177 tracked**, run twice identically. There is no results
artifact anywhere — no JSON, no verdict file — and the shared `regression.db` is unstamped and stale
per #1525's own operator note.

The demotions are each defensible on their own terms (#1526's rationale — _"a 'pass' status on a row
that fails at HEAD is a mis-status, not a gate"_ — is correct). The aggregate effect is that
**71% of the gauntlet corpus (218 of 306) does not gate**, and the headline that circulates is the
number after the failures were removed from the denominator.

### 2.3 The country sweep — what coverage actually looks like

400 oracle-verified candidates. 400/400 resolved by the Google oracle with zero `ZERO_RESULTS`;
7 `partial_match` rows parked; **393 through the pipeline; 279 pass (71.0%); 114 fail.**

Failure taxonomy, computed from the JSONL:

| Class                  | Count |
| ---------------------- | ----- |
| `bare_city_global`     | 34    |
| `bare_city_namesake`   | 17    |
| `spelling_variant`     | 16    |
| `bare_city_same_admin` | 9     |
| `exonym_script`        | 7     |
| `city_country_same`    | 4     |
| 25 further kinds       | 27    |

By the pre-registered draft classes: class 1 (bare-capital/namesake) **71 of 114** — the largest in
absolute terms, as predicted. Class 3 (country-distinctive addressing structures) **13 of 31 = 42%**
— the highest per-row rate, and the draft ranked it _last_. Class 2 (exonym/renamed/script) 30 of
137 = 22%, the safest.

**27 rows resolve to nothing.** The batch note's own wording: _"the honest failure, and the one that
does not violate the meaning-of-zero rule."_

**29 of the 114 share one root cause, and it is a data defect, not a model one.** `candidate.db` and
`admin-global-priority.db` disagree on what a synthetic place id means: **743,853 of 1,670,055 joined
rows (44.5%) name a different place in each**, 212,993 of them `is_primary=1`. `geocode "Gaborone"`
returned a Styrian hamlet named Aichegg. `Kinshasa` returned a Lithuanian place with a population
field of 16,000,000. The #1514/#1517 fold fix addressed the mechanism; the artifact rebuild is what
converts the fix into resolved rows, and #1507's grading wire-up on 2026-08-06 moved 5 of 7
family-A rows to passing. Two remain wrong on coordinate alone (`dj-cs-djibouti` 65.9 km,
`cg-cs-brazzaville` 453.1 km).

### 2.4 Competitive position — the number that decides bar (b)

The newest competitive parity scorecard is **`parity-scorecard-2026-07-02.md`, 35 days old, scoring
model 5.0.0** — four model majors behind shipped. SCOPE invariant 1 requires a full re-score every
five promotes or on any floor-lowering promote; 5.0.0 → 9.0.0 is well past that, and the v9.0.0-base
spec re-anchored two floors outright. **The cadence rule is unmet.**

Its only competitor column is libpostal, on three arenas: libpostal-clean 30% (down from 36%),
perturb 78%, postal-edge 24%. The parser edges the retired v0 rule baseline on canonical input by
one point, 30 vs 29.

The only same-harness three-way against the systems mailwoman claims to replace is
**`2026-06-23-competitive-benchmark-3way.md`, 45 days old, model v4.x, n=60/locale, 420 rows**:

| System              | @1 km | @5 km | @25 km  | no-result |
| ------------------- | ----- | ----- | ------- | --------- |
| mailwoman           | 24%   | 60%   | 77%     | 14%       |
| mailwoman + rescore | 26%   | 63%   | **80%** | 8%        |
| Nominatim           | 77%   | 80%   | 81%     | 17%       |
| Pelias              | 71%   | 83%   | **88%** | 2%        |

Its own reading, verbatim: _"Pelias is the strongest system here — 88% @25km all-panel, 2%
no-result… It is the real bar, and it is ahead of us overall."_ EU-only, mailwoman+rescore reaches
88% against Pelias 89%. AU is 35% against Pelias 78% and Nominatim 97%.

**Two model majors of resolver and gazetteer work have landed since that measurement, and none of it
has been scored against Pelias.** The founding objective's status is therefore _unknown, last known
behind_. That is the single highest-changeage measurement available to this project right now, and it
needs no GPU.

Google appears in no benchmark. It is a verification oracle for case authoring only, which the
`geocode-oracle` README states correctly.

### 2.5 Drop-in API surfaces

The README sells three wire-compatible drop-ins. All three ship at 9.0.0 and serve their routes.
**None has a single test comparing its output to the upstream it claims to replace.**

The two files that look like parity fixtures — `nominatim/test-fixtures/search-golden.jsonl` and
`libpostal/test-fixtures/parse-golden.jsonl` — are self-captures. The capture script says so in its
own header: it spawns `nominatim/out/cli.js serve` on port 8199 and records mailwoman's output. Their
only consumer is a file-integrity guard that asserts row counts and field types. The only upstream
verification anywhere in the repo is a comment in `photon/projection.ts:43` saying "verified against
photon.komoot.io" — a human eyeballed it once, and nothing executable holds it.

Named gaps, verified in the code:

| Surface     | Gap                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| nominatim   | **`/search` returns at most one result regardless of `limit`** (`cli.ts:246` `[out].slice(0, limit)`)                                   |
| nominatim   | `viewbox` not accepted at all; `bounded` parsed with nothing to bound to                                                                |
| nominatim   | `polygon_geojson` / `_kml` / `_svg` / `_text` / `_threshold`: zero occurrences                                                          |
| nominatim   | `extratags`, `namedetails`, `dedupe`, `exclude_place_ids`, `featureType`, `layer`, `email`: absent                                      |
| nominatim   | structured query is faked — fields joined into free text; **`county` parsed then dropped**                                              |
| nominatim   | `/lookup` → 501 (documented as planned)                                                                                                 |
| photon      | **`bbox` is a typed engine field with no wire path** — in `engine.ts:68`, absent from `schema.ts` and the handler                       |
| photon      | `osm_tag` / `layer` / `lang` / `radius` parsed, never read by the real engine; the test proves plumbing to a mock                       |
| photon      | `location_bias_scale`, `distance_sort`, `debug`, `zoom`: absent                                                                         |
| libpostal   | `/expand` has **no language handling** — upstream's `languages` option has no analogue                                                  |
| libpostal   | `/expand` returns `{expansions:[...]}`, not the bare array common REST servers return                                                   |
| annotations | `sun` carries only `apparent`; OpenCage returns astronomical/civil/nautical. `SunTimes.noon` has no `toOpenCage` mapping and is dropped |
| annotations | `roadinfo`, `what3words`, `OSM` blocks absent; `wikidata`/`fips` typed but unpopulated                                                  |

`@mailwoman/api` (native, 40 tests plus a live-engine suite) and `@mailwoman/mcp` (9 tools, 50 tests)
are in better shape; mcp's `server.ts` and `cli.ts` — the stdio transport, arg parsing and lazy weight
load, which is the whole operational claim — have **zero coverage**, stated in the test
header.

The AGENTS.md table is wrong in three places: `fastify` is at 9.0.0 with a complete plugin, four
routes and 10 tests, not a `0.0.1` name reservation; `mcp` has 9 tools, not 5; `nominatim` also
serves `/` and `/openapi.json`.

### 2.6 Per-surface summary

| Surface              | Where we sit                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parse (US)           | Gate PASS on all floors. Street-name span F1 **75.2** against a standing 0.90 target                                                                              |
| Parse (FR)           | Gate PASS. `fr.region` 44.1 → 81.2, `fr.cedex_real` 99.8. Held-out BAN beats production z=2.85                                                                    |
| Parse (GB)           | The v9 cure landed: gb-golden 318/318 with the anchor fed; dependent_locality 0 → 205/207. **GB is not a declared tier** — it has capability without a tier claim |
| Parse (JP)           | 0.9928 @15 km on a 20k held-out board, bar was 0.70. **No serving path.** No `neural-weights-ja-jp` workspace exists                                              |
| Geocode              | 71% on the 393-row oracle sweep; 27 rows resolve to nothing; last competitor measurement had Pelias ahead 88 to 80                                                |
| Drop-in APIs         | Routes ship, zero upstream parity tests, named parameter gaps in all three                                                                                        |
| Demo                 | Structurally pinned to the shipped weights package (invariant 2 enforced by construction, not by memory)                                                          |
| npm                  | Clean. 48 workspaces at 9.0.0, lockstep, Trusted Publishing                                                                                                       |
| Docs                 | Site ships; the repo-root documents have drifted (§5.4)                                                                                                           |
| Record matching      | Parked pending funding or a pilot, with measured evidence banked (NPPES coord-blocked F1 68.1%)                                                                   |
| Spatial layers / POI | 13.68M-row `poi.db`, read-time ancestry and `gersID` landed 2026-07-19                                                                                            |

---

## 3. The open-issue review

74 open issues. Classification below; where a call is a judgment rather than a reading, it says so.

### (a) DONE-BLOCKING — 14

Each stands between today and one of the project's own definitions of done.

| #    | Title (short)                                                | Which definition it blocks                                                                            |
| ---- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 229  | val-set stratification — fine + non-US eval coverage         | #488 DoD, "eval story in every shipped locale"                                                        |
| 378  | pocket-budget SLO                                            | #488 DoD, "a pocket tier that still installs nothing". PARKED with check-back                         |
| 486  | repair retirement                                            | SCOPE invariant 4 — standing, never closes, but the accounting must be current                        |
| 493  | lossless decomposition — serializer default decision         | #488 Phase 4, last unfinished item                                                                    |
| 1039 | lexical country prior for the no-postcode tail               | The country sweep's dominant failure class                                                            |
| 1102 | fragment/twin mass erodes US region+locality recall (~2.5pp) | Its own title calls it "the promote blocker"                                                          |
| 1142 | gazetteer importance unknown-as-zero; shipped FST stale      | PARTIAL — #1538 cured defects 1 and 2; the stale-FST rebuild remains                                  |
| 1492 | promoted-artifact swaps race CI on the shared data root      | ROAD_TO_V9 §6 I5, untouched                                                                           |
| 1497 | FST decoder bias invisible to every live eval                | PARTIAL — board now discriminates; `eval gauntlet` still FST-blind, per the fixing commit's own words |
| 1516 | invariance runner measures a path users don't take           | PARTIAL — I4 landed, **I1 (the issue title) untouched**; runner still defaults en-US per row          |
| 1519 | multi-word toponym/street truncation, 15 rows                | Demoted from gating; returns to gating when fixed                                                     |
| 1529 | intersection queries have no crossing-point computation      | Explicitly labeled a Pelias-parity gap                                                                |
| 1537 | geocode path collapses famous-namesake candidates to one     | Starves the declared-ambiguity margin — blocks ROAD_TO_V9 §2/§4                                       |
| 1539 | suffix-boundary over-greed, 125 golden rows                  | Directly moves `us.street`, the metric furthest from target                                           |

### (b) QUALITY — 17

Real, but the product is defensible without them: #372 (flatbush), #376, #435, #444, #456, #517,
#827, #997, #1010, #1088, #1095, #1096, #1123, #1361, #1371, #1372, #1375, #1377, #1523, #1528.

### (c) ROADMAP — 27

New capability, not debt: #13, #29, #35–#40 (eight adapter clusters, parked), #239, #243, #245,
#288, #293, #295, #296, #297, #470, #477, #488 (the epic itself), #598, #602, #603, #655, #733,
#994, #996, #1070, #1100, #1176, #1177, #1266, #1267, #1366, #1494, #1503.

Two are worth naming. **#1176 (the v8 CJK epic)** states its success criterion as _"v8 ships a model
that parses JP… the first non-Latin parse claim mailwoman makes."_ v8 shipped without it and v9
shipped without it; ROAD_TO_V9 §8 parks it explicitly. The epic has outlived two majors of its own
name. **#598 (record matching)** is parked by an operator decision with the evidence banked — that is
a healthy park, not a stall.

### (d) STALE — recommend closing with receipts, 5

| #        | Receipt                                                                                                                                                                        | Confidence                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| **1507** | `58ce7a17e` (#1525) — `check-case.ts:107-124` grades `expect_place_id`/`expect_place_name` against `hierarchy[0]`; 7 rows carry it; mutation-checked (disabling fails 4 of 16) | Highest                      |
| **1505** | `91e6f8b88` (#1522) — AGENTS.md now lists bdc:45, filer:46, fastify:62, react:65, apps:76, hf-publish:78                                                                       | High                         |
| **1491** | `91e6f8b88` — `--corpus-version` rename plus an AST guard over all 133 command modules                                                                                         | High                         |
| **1493** | `91e6f8b88` — `RELEASING.md:399` records `fst-global-priority.bin` RETIRED 2026-08-06; note the HF-bucket deletion is a release-time operator action                           | High, with a caveat          |
| **1495** | `91e6f8b88` — `build-candidate.ts:311` `foldPostcodeExtract`. Code-complete; **the artifact lands at the next `gazetteer build candidate`**                                    | Close with the caveat stated |

**Two traps.** #1539 and #1519 look closed by their commit subjects and are not. `f2c9810b7` touches
three files for 18 lines and its own message says the over-greed is _"now a NAMED failure mode
… with its training change recorded"_ — recorded, not fixed. #1516 is half done and **its title
describes the half that is not**.

### (e) INFRA / PROCESS — 4

#1123 (worktree isolation), #1492, #1523, #1528. #1492 is also in (a) because ROAD_TO_V9 named it a
release-gate item.

### The stale board, not the stale issues

Epic #488's checkboxes carry four unchecked rows whose issues are closed: #473 and #375 and #294
(all COMPLETED 2026-08-05 with substantive receipts) and #379 (2026-07-06). The 2026-07-02 truth-pass
note in that issue warns about exactly this drift in the other direction. It has re-accumulated.

---

## 4. The gap list, ranked

No time estimates. Work-shape only: **single-lane** (one engineer, one thread), **multi-lane**
(coordinated across packages), **arc-with-preregistration** (needs bars written and operator sign-off
before it starts), **external-dependency** (waits on someone outside the project).

### Bar (a) — "v1.0-grade production geocoder for tier-1 locales"

Tier 1 is US and FR only. This is the nearest bar and the gaps are mostly bounded.

| #   | Gap                                                                                                                                            | Shape                    | Kind                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------ |
| a1  | Re-score the competitive parity scorecard on model 9.0.0 (invariant 1 is unmet; the last one scores 5.0.0)                                     | single-lane              | bounded engineering                        |
| a2  | Restore the five NOT-SCORED Run B bars — G1 harness, G2 reference, G5/G8 fixtures, G6 harness                                                  | single-lane              | bounded engineering                        |
| a3  | Write the arena.perturb 78 → 66 delta into the release row, model card and a record; decide whether it is a regression or an instrument change | single-lane              | bounded engineering, then an operator call |
| a4  | Fix #1539 (125 golden rows of suffix over-greed) — the training change is recorded                                                             | arc-with-preregistration | needs a training run                       |
| a5  | Fix #1537 (famous-namesake candidate collapse) — pre-existing, upstream of intent                                                              | single-lane              | bounded engineering                        |
| a6  | Close #1516 I1 — invariance runner on the pipeline path with per-row locale                                                                    | single-lane              | bounded engineering                        |
| a7  | Rebuild and reship the stale FST (#1142 residual) and the candidate DB carrying #1495                                                          | single-lane              | bounded, plus a release action             |
| a8  | Close #1492 — private symlink-overlay data root for CI                                                                                         | single-lane              | bounded engineering                        |
| a9  | Publish a gauntlet results artifact and re-stamp `regression.db`; make "88/88" a measurement                                                   | single-lane              | bounded engineering                        |
| a10 | Reconcile the `calibrate` default with the calibrated claim                                                                                    | single-lane              | one doc fix or one gated flip              |
| a11 | Move `us.street` from 75.2 toward the 0.90 parity target; `house_number` 0.9315 → 0.97                                                         | arc-with-preregistration | open research plus training                |

a1 through a10 are bounded. **a11 is the one open research question on this bar**, and it is the
oldest: the #492 stability-ceiling work established that `us.street` sits at an equilibrium set by
corpus mixing ratios, not by any single change.

### Bar (b) — "Pelias-replacement parity"

Everything in (a), plus:

| #   | Gap                                                                                                             | Shape       | Kind                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------- |
| b1  | Re-run the three-way benchmark on 9.0.0; the standing result has Pelias ahead 88 to 80 @25 km                   | single-lane | bounded engineering — **the highest-changeage single measurement available** |
| b2  | Precision, not recall: 26% @1 km against Nominatim 77 / Pelias 71. The gap is address-point coverage, not parse | multi-lane  | data acquisition, per-country                                                |
| b3  | AU at 35% against Pelias 78 / Nominatim 97                                                                      | multi-lane  | data plus a extract                                                          |
| b4  | #1529 — crossing-point computation. TIGER edges already back the interpolation DB                               | single-lane | bounded engineering                                                          |
| b5  | Upstream parity tests for all three drop-ins — nothing today compares them to what they replace                 | single-lane | bounded engineering                                                          |
| b6  | Nominatim `limit` capped at 1; `viewbox`, `polygon_*`, structured `county`                                      | single-lane | bounded engineering                                                          |
| b7  | Photon `bbox` wire path; `osm_tag`/`layer` honored or removed from the schema                                   | single-lane | bounded engineering                                                          |
| b8  | libpostal `/expand` language handling                                                                           | single-lane | bounded engineering                                                          |
| b9  | Coverage: 27 sweep rows resolve to nothing; 71 of 114 failures are class-1 namesake                             | multi-lane  | data plus the #1039 country prior                                            |
| b10 | The synthetic-id artifact rebuild that closes the 44.5% join disagreement                                       | single-lane | bounded, but it is a full gazetteer rebuild                                  |

b2 and b9 are the substance; the rest is bounded work. **Nothing on this bar is blocked on research.**
It is blocked on measurement (b1), on data (b2, b3, b9), and on finishing surfaces that were built to
80% (b5–b8).

### Bar (c) — "the full vision"

Everything above, plus:

| #   | Gap                                                                                                                                                                     | Shape                                              | Kind                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| c1  | JP serving path — char-path inference, weights packaging, the `ja-jp` overlay. The 0.9928 model exists and cannot be called                                             | arc-with-preregistration                           | bounded engineering, meaningful volume                                  |
| c2  | Suggestion layer — **0 of 13 bars met**; no `suggest/` workspace; the C.4 attribution triple (`core` + `resolver-wof-sqlite` + `formatter`) blocks every downstream bar | multi-lane, then arc                               | bounded; §C.6 says explicitly no retrain needed                         |
| c3  | Postcode-structure arc — **2 of 13 bars met** (B3-1, B1-4). Artifact built, nothing reads it                                                                            | single-lane mostly; B3-4 needs US ZCTA acquisition | bounded plus one acquisition                                            |
| c4  | Intent §4 — 4 kinds landed; blocked downstream on #1537 and on poi.db debt                                                                                              | single-lane                                        | bounded engineering                                                     |
| c5  | KR, CN, TW parse                                                                                                                                                        | arc-with-preregistration                           | data acquisition first — KR has no adopted open path                    |
| c6  | Record matching (#598 family)                                                                                                                                           | multi-lane                                         | **operator decision** — parked pending funding or a pilot               |
| c7  | `@mailwoman/osm` publish, HK ALS, the Lite artifact line                                                                                                                | external-dependency                                | **ODbL counsel review, unretained**                                     |
| c8  | Starter kits — 22 unchecked boxes, zero checked, no artifacts exist                                                                                                     | single-lane                                        | bounded, plus two operator gates (org repo creation, npm first-publish) |
| c9  | Secondary address support (#1100), locator[] (#295/#296), script-extract routing (#245)                                                                                 | arc-with-preregistration                           | schema changes ride retrains                                            |

**The only genuine external blocker across the whole project is c7** — the ODbL question holding
`osm/`, and it has no counsel behind it. The dossier records the operator's position verbatim: _"do
your best and I'll forward it over when the project actually pays for one."_ Two items in that
dossier (L4 — the repo contradicts itself on the WOF licence, CC0 in the licensing pages against
CC-BY 4.0 in `resolver-wof-sqlite/README.md` and the HF card; and L5) are fact-finding that needs no
lawyer and can proceed today.

---

## 5. The liabilities a "done" claim has to reckon with

### 5.1 Recovery is zero

Delete a postcode from an address and **0 of 139 rows recover it**. The parser has no path from
"this address is missing its postcode" back to the postcode, and the gazetteer knows it. This is the
finding that shapes the suggestion layer's entire design, and it means any claim of the form
"mailwoman repairs degraded input" is currently false for the single most valuable component.

### 5.2 The substitution hazard

Worse than not recovering: **16 of 139 rows emit a different token as the postcode.**

```
us-subvenue-googleplex-building   94043 deleted -> "1600"     (the house number)
us-op3-twin-peaks-golf-longmont   80503 deleted -> "1200"     (the house number)
pr-op3-place-at-the-sea-ponce     00716 deleted -> "3499"     (the house number)
mx-op3-one-villahermosa-2000      86035 deleted -> "2000"     (part of the venue name)
venue-bar-1802-pascal             75005 deleted -> "1802"     (the venue's year)
us-op3-four-corners-monument      86514 deleted -> "NM-597"   (a route number)
im-op2-simpsons-field           IM2 4RE -> "5G8H+8F5"         (a plus code)
gb-op3-odyssey-w4-belfast       BT3 9QQ -> "W4"               (part of the venue name)
```

A confidently wrong postcode is more expensive than an absent one, because every downstream
coherence pass trusts it. The postcode arc's shape-exclusion mechanism (bars B1-1 through B1-3) is
the designed cure and **none of those three bars has been run**.

### 5.3 The venue-name-reads-as-structure class

The same failure shape recurs where a named place carries digits or a street-type word: the venue's
year read as a postcode, the venue fragment read as an outward code, `Pier 39`'s long-standing unit-tag
quirk. The v9 sub-venue extract is the first training-side answer to it. It is not resolved.

### 5.4 The instruments have been lying, and some still are

The last week's receipts are largely a catalogue of gates that did not measure what they claimed:

- `expectPlaceID`/`expectPlaceName` were in the schema, the DDL and the builder, and `checkCase`
  read neither. Every family-A row graded green while returning an Austrian hamlet. Fixed #1525.
- The invariance runner grades the raw classifier, en-US for every row — it scored Run B's _gained_
  GB capability as a loss. **Not fixed.**
- `regression.db` can be rebuilt from a stale compiled tree. Stamped in #1525; the shared artifact is
  currently unstamped.
- `gazetteer postcode-binary` wrote an empty GB bin and exited 0.
- `resolveWeights` hard-coded a v6 lexicon filename while the model trained against v7.
- The freshness guard compared zero checksums.

Six instrument defects in one cycle, in a project whose entire method rests on pre-registered gates.
The fixes are landing fast, and the class is not closed.

### 5.5 Territory coverage

Four PR/VG/VI rows were demoted from gating because they pass under the old model _"by margins their
own notes call accidental."_ Puerto Rico has TIGER coverage the corpus never ingested. This is a
known, bounded data cure (ROAD_TO_V9 §5-C) that has not started.

### 5.6 Documentation drift at the repo root

- `CHANGELOG.md` stops at **4.15.0** and links `docs/articles/releases.mdx`, which does not exist.
- `README.md` links `docs/articles/plan/` and `docs/articles/evals/` — neither exists — says
  **"33 published packages"** where the release list holds 48, and carries the **"Drop-in servers"
  section twice**.
- `TODO.md` is frozen at 2026-05-25 and describes a training run as "in-flight."
- `AGENTS.md` is wrong on `fastify` (a working 9.0.0 plugin, not a name reservation) and on mcp's
  tool count.
- The v9.0.0 release row states 121 country dirs; the tree has 115.

The #488 DoD ends with _"documentation a stranger can onboard from."_ The published site is in good
shape. The first four files a stranger opens in the repo are not.

### 5.7 The coverage register that ROAD_TO_V9 required

§5-B, tier B: _"the release notes state coverage honestly (the 'what mailwoman does not cover'
register)."_ No such register exists anywhere in the tree. The v9.0.0 release row names four
territory rows and the truncation pair; it does not carry the 27 no-coordinate rows or the 114-row
sweep failure taxonomy. **This is the one ROAD_TO_V9 B-tier item that did not land**, and it is the
cheapest remaining item on the list.

### 5.8 JP has no serving path

A model that scores 0.9928 on a held-out 20,000-row board, holding out whole municipalities, sits in
`$MAILWOMAN_DATA_ROOT/models/v8-jp-full-s42/step-024000/` and cannot be called by anything. There is
no `neural-weights-ja-jp` workspace. The one `ja-jp` artifact in the tree, `fst-ja-jp.bin`, is
described by its own module as _"an artifact no command can rebuild."_

---

## 6. What is genuinely strong

Direct statement without extrapolation.

**The method.** Pre-registered bars, falsified changes reverted rather than shipped, verdicts written
down with the numbers that produced them. Twelve preregistration documents in `docs/superpowers/plans/`
carry graded verdicts, including three that read NEGATIVE and stopped. The sp-vocab-prune arc was
killed by its own premise check. That discipline is rare and it is the reason this review could be
written at all — almost everything asked for was already measured by someone who wrote down what
they measured.

**The v9 anchor cure.** The #1467 root cause — every training config used a 67,708-key anchor lookup
with _zero letter-bearing keys_, so the GB slot never took gradient — was found, cured, and proven
with Fisher mass on the GB slot at 11.28% against CA/JP exact-zero controls. gb-golden went 294 → 318
of 318 across three registers; GB `dependent_locality` went 0 → 205/207. That is a real capability
gain with a mechanism-level receipt, not a metric that moved.

**FR.** `fr.region` 44.1 → 81.2, `fr.cedex_real` 90.5 → 99.8, held-out BAN beating production at
z=2.85, the fragment board at 0.977 across 2,800 fixtures. FR is the locale where the architecture's
claims are most clearly demonstrated.

**The release train.** 48 workspaces in lockstep, Trusted Publishing over OIDC, pack-then-publish for
the `workspace:*` translation, symlink dereferencing as a safety net, `publishConfig.exports` injected
at pack time with a guard that refuses to publish a missing target. Every one of those exists because
something broke once and was written down. It works.

**The gazetteer and layer discipline.** Sealed, read-only, provenance-tracked, license-tagged, with a
meaning-of-zero rule that distinguishes absence from zero. The NI postcode extract shipping
ancestry-only with zero coordinates — because inventing them would be the lie — is the discipline
working under pressure.

**The corpus of failures.** 306 gauntlet cases across 115 countries, 400 oracle-verified sweep
candidates, per-country JSONL, ablation ladders, a degradation map. Most projects at this stage know
what works. This one has a written, structured, growing account of what does not, and 71% of it does
not gate precisely because someone refused to grade a failing row as a pass.

**JP.** 0.9928 at 15 km against a pre-registered 0.70, on a board that holds out whole
municipalities, from a 2,237-character vocabulary trained from scratch in about 80 minutes. The
architecture question that blocked non-Latin script for the project's whole life is answered. Only
the plumbing is missing.

---

## 7. The answer

**Bar (a), tier-1 production geocoder: close.** Ten bounded items and one open research question
(`us.street` toward 0.90). Nothing on this bar waits on data, a lawyer, or a decision.

**Bar (b), Pelias replacement: unknown, last known behind — and the measurement is the work.**
Pelias led 88 to 80 @25 km forty-five days and two model majors ago. Precision at 1 km is the real
gap (26 against 71) and it is address-point coverage, not parsing. Re-running that benchmark on
9.0.0 costs no GPU and would tell this project more about its position than anything else it could do.

**Bar (c), the full vision: two open arcs at 2-of-13 and 0-of-13 bars, a JP model with no serving
path, and one external blocker with no counsel behind it.** None of it needs research. Most of it
needs lanes.

The gap between what the receipts show and what the summaries say is the finding this review would
put first. The measurements are good. The narrative layer built on top of them — a release row that
quotes two failing floors as gains, an "88/88" that is a denominator after six demotions, a
`README` that promises calibrated confidences a default consumer does not get, and a 12-point arena
drop that exists in one JSON file and nowhere else — has drifted from them. Closing that gap is a
week of writing, not a quarter of engineering, and it is the difference between a project that can
claim done and one that can prove it.

---

## Corrections to numbers in circulation

| Circulating                    | Actual                                                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "gauntlet 88/88"               | 88 is the count of **gating** rows after six failing rows were demoted on 2026-08-05/06. The last measured run is #1525's **92/94 gated, 177 tracked**. No results artifact exists |
| "279/400 pass"                 | 400 candidates → 7 `partial_match` parked → **393 through the pipeline**; 279 pass = 71.0% of 393, 69.75% of 400                                                                   |
| "45 namesake rows"             | No 45 anywhere. `bare_city_namesake` = **17**; the draft's class-1 (bare capital / namesake) = **71 of 114**                                                                       |
| "27 no-coordinate rows"        | Correct                                                                                                                                                                            |
| Ledger 9.0.0 `corpus_version`  | Copied verbatim from the 7.0.0 row (`v0.13.0-latam`); the model card and release row both say `v0.17.0-batch`. `training_steps: 8000` contradicts "step-60000" in both rows        |
| Release row "121 country dirs" | 115 two-letter dirs plus `generalization/`                                                                                                                                         |
| README "33 published packages" | 48 in the release list; 53 workspaces                                                                                                                                              |

## Sources

`docs/engineering/SCOPE.mdx` · `docs/records/site-2026-08/concepts/what-mailwoman-is.mdx` ·
`ROAD_TO_V9.md` · epic #488 · `evals/scores-by-version.json` ·
`mailwoman/eval-harness/gates/v9.0.0-base.json` ·
`docs/records/evals/2026-08-05-v420-base-anchor-v2-run-b.md` ·
`docs/records/evals/2026-08-05-v8-jp-full-24k-gate.md` ·
`docs/records/evals/competitive-parity/parity-scorecard-2026-07-02.md` ·
`docs/records/evals/competitive-parity/2026-06-23-competitive-benchmark-3way.md` ·
`mailwoman/eval-harness/gauntlet/cases/` (306 rows, `batch-notes.md`) ·
`docs/superpowers/plans/2026-08-05-postcode-structure-arc.md` ·
`docs/superpowers/plans/2026-08-05-suggestion-layer.md` ·
`docs/superpowers/plans/counsel-dossier.md` · `docs/engineering/reference/runtime-flags.mdx` ·
`docs/engineering/CONTRIBUTING_MODEL_WORK.mdx` · the `nominatim`/`photon`/`libpostal`/`annotations`/
`api`/`fastify`/`mcp` workspaces · `gh issue list --state open` (74) ·
`git log --since=2026-08-04`.
