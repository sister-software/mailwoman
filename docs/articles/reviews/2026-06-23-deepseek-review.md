# Mailwoman project review — `feat/geonames-postcode-coverage`

**Date:** 2026-06-23 · **Branch:** `feat/geonames-postcode-coverage` (6 commits ahead of main) · **Scope:** full project survey with emphasis on the branch's eval tooling, resolver levers, data pipeline, and open strategic questions.

---

## Overview

This branch carries a cluster of work that takes mailwoman from "the US champion" to "competitive in Europe." It ships ~925 lines across 11 files: two resolver levers (span-rescore recovery + postcode-consistency disambiguation), a GGeonames-to-SQLite postcode shard builder, a 3-way competitive benchmark harness (mailwoman vs Nominatim vs Pelias), a failure-mode classifier, an AU word-order probe, and the blog post + demo wiring that makes the levers visible.

The headline: with both levers active, mailwoman leads Nominatim and Pelias on the @25km right-area metric across a 7-locale EU+AU panel (90.0%), from a 30 MB browser model with no Elasticsearch. The star is Europe: mailwoman 94.2% vs Nominatim 78%, Pelias 89%. Australia is the open problem (65% vs Nominatim 97%), now characterized as a word-order training-data gap, not a capability deficit.

---

## What's on this branch (6 commits)

### 1. `#193` — GeoNames-sourced postcode shard for WOF-gap countries

**`23d866f5`** — `scripts/build-geonames-postcode-shard.ts` (291 lines)

The backbone of the EU postcode coverage push. WOF ships postcode entities for US/NL/FR/DE/IT/ES but zero rows for PL, CZ, PT, AU, AT, and others. The existing `backfill-postcode-centroids` pipeline treats GeoNames as a COORDINATE source keyed onto existing WOF records — useless where WOF has nothing to key onto.

This builder makes GeoNames the RECORD source too. It streams `allCountries-postal.txt`, accumulates centroid+bbox per (country, postcode), emits a `spr` table in the exact schema `build-candidate --postcodes` consumes, with synthetic IDs in the 8B range (well above WOF's ~907M ceiling). Name-variant dedup: stores both the raw code ("26-300") and separator-stripped form ("26300") so either written form resolves. Optional `--fold-into` pass copies an existing candidate gazetteer and inserts the postcode rows directly, bypassing a full rebuild for demo staging.

**Quality observations:**

- The synthetic-ID convention (`SYNTH_ID_BASE = 8_000_000_000`) is well documented and non-colliding.
- The `DROP TABLE IF EXISTS` + recreate pattern is correct for a regenerated artifact; stale rows can't survive a country-set change.
- The hot-write bulk INSERT (`db.exec("BEGIN")` / `prepare` / `COMMIT`) follows the repo's leave-as-raw convention for throughput paths, documented with the rationale.
- The `foldIntoCandidate` pass correctly handles country-code insertion for countries the candidate DB doesn't yet carry, and runs `VACUUM` after mid-tree inserts (WITHOUT ROWID clustering).
- No test for the builder itself — it's a CLI script. This is consistent with the repo's other build scripts (none have unit tests; validation is "does the downstream eval score improve?").

### 2. Benchmark + blog — mailwoman vs Nominatim vs Pelias

**`ec42ffab`** — `scripts/eval/competitive-benchmark.ts` (+34 lines), `docs/articles/evals/2026-06-23-competitive-benchmark-3way.md` (111 lines), `docs/research/2026-06-23-we-graded-ourselves-against-the-incumbents.mdx` (67 lines)

A clean, honest competitive benchmark. Key design decisions that are correct:

- **Primary metric = resolve-rate @ 25 km.** "No result" counts as a miss. This is the honest denominator: it surfaces coverage + graceful degradation rather than letting rooftop precision hide a low match rate. Mailwoman resolves to admin/postcode centroids, so a km-to-rooftop metric would unfairly reward Nominatim/Pelias rooftop hits.
- **Identical inputs.** Same raw OA address strings, same country hint for all three systems.
- **Two-axis reporting.** Resolve-rate (the denominator) AND conditional median error (among resolved rows) are reported separately — prevents lumping "half the rows failed but the rest were perfect" into one misleading number.
- **Pelias is country-scoped** for this run (previously unscoped, which understated it by allowing wrong-country matches).
- **`--span-rescore` grades base + lever from a single parse.** The model parses once; both `resolveTree(spanRescore:false)` and `resolveTree(spanRescore:true)` are run from `structuredClone(tree)`. Independent, not serial.

The blog post (`docs/research/2026-06-23-we-graded-ourselves-against-the-incumbents.mdx`) is draft (`draft: true`) but publication-ready narrative quality. It accurately characterizes the centroid-vs-rooftop trade, the AU drag, and the two-fix story.

### 3. `#370` Lever A — postcode-disambiguated locality selection

**`a113506b`** — `core/resolver/postcode-consistency.test.ts` (93 lines), `core/resolver/resolve.ts` (+85 lines), `core/resolver/types.ts` (+13 lines)

The single biggest miss class on the EU panel: a same-named town resolved to the WRONG instance while the postcode that would disambiguate it sits resolved in the same tree. Example: "06260 Saint-Pierre" lands 617 km off because the resolver picked the Saint-Pierre in Vendée, not the one in Alpes-Maritimes — despite postcode 06260 resolving correctly.

The lever is backend-agnostic. After the admin resolution walk, it finds the resolved postcode anchor, then walks every resolved locality/dependent_locality node. For each one farther than `gateKm` (default 50 km) from the postcode, it re-picks from the node's already-captured `alternatives` (the runner-up gazetteer candidates `decorateNode` stored). Falls back to the postcode point if no alternative reconciles, flagging `postcode_city_mismatch`.

**Code quality:**

- 5 well-structured tests covering: re-pick, fallback, already-consistent no-op, byte-stability when unset, no-postcode no-op.
- The `alternatives` field is typed `unknown[]` on `AddressNode` because `decoder/types.ts` can't import resolver types. The cast to `ResolvedPlace[]` is sound (it IS what `decorateNode` stores) and documented inline.
- Default-off + byte-stable when unset.
- Composes correctly with postcode coverage (#193): only fires where the postcode resolved to a point; a no-postcode tree is untouched.

**One concern:** The `alternatives` cast is technically a layer-escape. The resolver types module can't be imported from the decoder types module without a dependency cycle, and the `unknown[]` type is a deliberate firewall. The cast works because `decorateNode` in the same file is the only writer. But if another code path ever writes to `node.alternatives` in a different shape, this cast becomes a runtime bug with no compile error. The resolver's test coverage protects against this within the resolver path, but not against external writers. Low risk given the repo's conventions; worth a comment in `decoder/types.ts` next to the `alternatives` field noting the contract.

### 4. `#370` span-rescore — raw-text locality recovery + production wiring

**Shipped across two commits:** `65c41b4c` (eval + falsifier) → `8e3de978` (production wiring, 8 tests)

**`core/resolver/span-rescore.ts`** (193 lines) — pure, backend-agnostic, browser-safe core. Enumerates whitespace-token spans from the raw input (diacritics intact, unlike the model's subword tokenizer), exact-matches them against the same-country gazetteer, longest-wins (the gold locality is the more-specific name — shortest-wins grabbed the ambiguous prefix "Tomaszów" of "Tomaszów Mazowiecki"). A postcode-consistency gate rejects matches far from where the postcode resolves.

This is the most architecturally disciplined piece on the branch.

**Design decisions validated by measurement:**

- Longest-exact-match-wins was proven superior to shortest-wins by the falsifier (`span-rescore-validate.ts`): gold-match 49→71%, p50 5.7→3.0 km.
- The `rescore_gated` metadata flag (boolean) is kept SEPARATE from calibrated confidence. DeepSeek consulted: folding it would break the ECE 0.0055 isotonic guarantee. A consumer thresholds on `metadata.rescore_gated` explicitly instead of inheriting a hidden per-country coverage map. This is correct.
- The `#685` brake (`hasResolvedPlace`) prevents the recovery from firing on an already-resolved tree — no second-guessing a working coordinate.
- Default-off in the library; the demo opts the lever ON (user-visible recovery is better than silence). The demo labels ungated recoveries "unverified" — the precision signal surfaced honestly.

**`core/resolver/span-rescore.test.ts`** (151 lines, 8 tests) — recovery, longest-wins, postcode gate acceptance, gate rejection, confident-span skip, `hasResolvedPlace`, resolveTree injection, byte-stable-when-unset. The fixture backend pattern (a tiny in-memory gazetteer with exact-normalized-name matching) is clean and sufficient for the logic under test.

**`core/resolver/resolve.ts`** — `applySpanRescore` integrates the recovery into the resolveTree path, hooked after the addressPoint/interpolation tiers. The integration is surgically simple: if `spanRescore` is set and the tree is empty (`!hasResolvedPlace`), call `findRescoreCandidate` and inject the result via `decorateNode`. 39 lines.

### 5. Lever B — extend GeoNames postcode fill to PT/AU/AT

**`7190ad4c`**

Extends the `#193` shard builder to PT, AU, AT. The benchmark's failure dump showed that Italy hit ceiling (Lever A alone fixed all its same-name-town misses) but PT/AU/AT still had the postcode-coverage gap — Lever A can't fire without a resolved postcode anchor. With both levers: AU 35→65 (+30pp), PT 78→88 (+10pp), AT 73→87 (+14pp).

### 6. AU word-order diagnosis

**`4b5e0f09`** — `scripts/eval/au-order-probe.ts` (97 lines)

Decisive. Quantifies the ceiling: the model parses AU addresses PERFECTLY in canonical order and mis-segments only AU's native postcode-first / house-number-last order. "3053 Carlton, Barry Street 50" → locality=Barry street=Carlton hn=3053 pc=50 (wrong); "50 Barry Street, Carlton 3053" → locality=Carlton street=Barry hn=50 pc=3053 (right). As-written: 65% @25km; reordered-to-canonical: 87%. The +22pp ceiling is the upside of AU-native-order training data (#208 G-NAF) — a model fix, not a resolver trick.

This is the German v0.9.2 artifact again — same root cause, different locale.

---

## Architecture observations

### The resolver lever pattern is maturing well

The three levers on this branch — `spanRescore`, `postcodeConsistency`, `addressPoints` — all follow the same disciplined contract:

1. **Default-off + byte-stable when unset.** No change to existing behavior without an explicit opt-in.
2. **Flag + gate-km pair.** Each lever has a boolean toggle and a tunable distance gate.
3. **No extra queries.** `postcodeConsistency` reuses the node's already-captured `alternatives`; `spanRescore` runs exact-match queries that are cheap against the gazetteer.
4. **Tests cover: on/off, corner cases, byte-stability.** The 8 + 5 new tests keep the pattern.

This is a maintainable extension surface. The risk is flag proliferation — each new lever adds two options to `ResolveOpts`. At 4 levers (addressPoints, interpolation, spanRescore, postcodeConsistency), the API is still manageable. Beyond 6–7, consider a `levers: ResolverLever[]` enum-bundle or a policy-driven resolver config.

### haversineKm duplication

`haversineKm` is defined independently in:

- `core/resolver/span-rescore.ts` (module-scoped)
- `core/resolver/resolve.ts` (function-scoped in `applyPostcodeConsistency`)
- `scripts/eval/au-order-probe.ts`
- `scripts/eval/failure-dump.ts`
- `scripts/eval/competitive-benchmark.ts`

Five near-identical implementations of the same 6-line function. The resolver copies differ only in variable naming (`la1`/`la2` vs inline). This is not a correctness bug — the math is trivial — but it is a maintenance hazard if the Earth's radius ever needs updating (joke) or if a precision issue surfaces in one copy. Consolidate into `core/spatial/haversine.ts` or a shared utility. Low priority; consistency cleanup.

### The eval tooling ecosystem is healthy

The branch ships four eval scripts that form a coherent diagnostic pipeline:

| Script                     | Purpose                                 | Input         |
| -------------------------- | --------------------------------------- | ------------- |
| `competitive-benchmark.ts` | 3-way resolve-rate @25km                | OA goldens    |
| `failure-dump.ts`          | Classify misses into cause buckets      | OA goldens    |
| `au-order-probe.ts`        | Quantify word-order ceiling             | OA AU goldens |
| `span-rescore-e2e.ts`      | A/B the flag on/off through resolveTree | OA goldens    |

This is a mature eval posture: start with a benchmark, classify the failures, drill into the worst locale's root cause, verify the fix end-to-end. The failure classifier's taxonomy (`EMPTY_postcode-parsed-unresolved`, `WRONG_locality_postcode-AVAILABLE`, `EMPTY_no-place-tag-parsed`, etc.) is directly actionable — each bucket names a lever.

### Demo wiring is appropriately cautious

PR #782 ports span-rescore into the browser demo cascade. Design choices are correct:

- Reuses `findRescoreCandidate` from `core/resolver` (exported via the barrel — browser-safe, no node deps).
- Recovery fires ONLY when the cascade produced zero hits (the demo's #685 brake).
- Ungated recoveries are labeled "unverified" — the precision signal is surfaced, not hidden.

---

## State of the open issues

The issue queue relevant to this branch's work:

| Issue                                                            | Relevance                                                                                                                                                       | Status                   |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **#781** — span-rescore v2 (always-recover + fitted calibration) | Natural next step: collect recovery calibration data, fit isotonic curve, dissolve the flag into a consumer threshold. Already DeepSeek-validated structurally. | Open                     |
| **#742** — world-coverage gazetteer missing ~98 countries        | The long tail of the #193 postcode-coverage problem. 97/195 countries covered now.                                                                              | Open                     |
| **#735** — national US street tier (50-state situs+interp)       | US rooftop beyond CA/NY/MI/DC — the precision gap behind the @1km numbers.                                                                                      | Open                     |
| **#531** — typo-tolerant retrieval (FTS edit-distance-1)         | Relevant to span-rescore: the recovery does EXACT match only; a 1-character typo kills it.                                                                      | Open                     |
| **#208** — G-NAF ingest (AU training data)                       | Directly blocks the AU word-order fix. The ceiling is measured (+22pp); the data is the blocker.                                                                | Not visible in open list |
| **PR #782** — demo span-rescore                                  | Demo wiring of the span-rescore lever. Open, waiting deploy-preview verification.                                                                               | Open PR                  |

The issues that are ALREADY SHIPPED but still open (a recurring pattern in this repo — see the night-shift postmortem's "4× verify-before-building confirmed: several 'open' issues can be closed"): none directly on this branch, but #370 (the parent span-rescore issue) is still open despite substantial shipped work. The issue body describes the parse↔resolve rescoring loop, which is a broader concept than the implemented span-rescore. The shipped work (raw-text recovery) is one slice of it. Consider updating #370's body or creating a sub-issue to track what's done vs what remains.

---

## Findings

### 1. The blog post is draft:true but publication-ready

`docs/research/2026-06-23-we-graded-ourselves-against-the-incumbents.mdx` is marked `draft: true`. It is a polished, honest narrative — the centroid-vs-rooftop trade is stated plainly, the AU drag is quantified, the two-fix story is clear. The draft flag should be removed and the post published. The trade-show differentiator (calibrated confidence, browser deployment, no Elasticsearch) is the story this post tells best, and it's the one the project should be telling right now.

### 2. The competitive benchmark's `--messy` flag is implemented but the run wasn't done

The benchmark harness supports `--messy` (drops commas, abbreviates street words, lowercases, removes dash-postcodes) but the published numbers are clean OA input only. The post declares "calibrated parser degrades better than a token-matching search index on messy input" as a claim that needs a separate run. The `--messy` run should be done before that claim appears in the published blog post, or the claim should be softened to "we expect" with a commitment to measure.

### 3. AU's root cause is characterized but the fix path has a dependency gap

The AU order probe (`scripts/eval/au-order-probe.ts`) conclusively shows the model CAN parse AU addresses — it just needs them in canonical order. The ceiling is +22pp. The fix is AU-native-order training data (#208 G-NAF). But G-NAF isn't in the corpus pipeline yet, and the issue isn't visible in the open queue. This is the highest-ROI single lever on the board (would lift all-panel from ~90 to ~93 and flip AU from trailing Pelias to competitive), and it lacks a tracked next step.

### 4. haversineKm duplication is technical debt

Five copies across core and scripts. Consolidate to `core/spatial/haversine.ts` or a shared utility. Not urgent, but each new eval script adds another copy.

### 5. The `alternatives` type-cast is sound but fragile

`resolve.ts:applyPostcodeConsistency` casts `node.alternatives` from `unknown[]` to `ResolvedPlace[]`. The cast is correct (only `decorateNode` writes it, and only with `ResolvedPlace[]`), but it's a cross-layer assumption that has no compile-time enforcement. A comment on `AddressNode.alternatives` in `decoder/types.ts` documenting the contract would close this.

### 6. The failure-dump classifier conflates two distinct "postcode-available" cases

`classify()` returns `WRONG_locality_postcode-AVAILABLE` when a postcode resolved AND the best coordinate came from a non-postcode placetype. But this bucket includes both "Lever A would fix this" (wrong locality instance, postcode anchor present) and "coordinate is from a street/address but wrong" (postcode is present but the error is elsewhere). Splitting this into `WRONG_locality_postcode-AVAILABLE` (locality-placed, far from postcode) and `WRONG_non-locality_postcode-AVAILABLE` (street/address-placed, postcode present but not the error) would make the lever targeting even sharper. Low priority; the current classifier is already good enough to drive lever decisions.

### 7. The GeoNames shard builder has no test but follows the repo convention

`scripts/build-geonames-postcode-shard.ts` is untested beyond manual invocation. This is consistent with other build scripts in the repo (none have unit tests). The validation path is the downstream eval score — which is the right validation for a data artifact. A future hardening pass could add a smoke test (build a tiny shard from a 5-line fixture, verify row count + synthetic IDs + name variants).

---

## Strategic read

### Where the project is

Mailwoman is now competitive with (and on Europe, ahead of) the incumbents on the right-area metric, from a 30 MB browser model. The centroid-vs-rooftop precision gap at @1km is real but stated honestly. The project has a mature eval pipeline: benchmark → classify → drill-down → fix → re-benchmark. The resolver lever pattern is disciplined and reproducible.

### What blocks the next tier

1. **AU word-order** — highest ROI lever, measured ceiling +22pp, blocked on G-NAF training data (#208).
2. **AT postcode coverage** — GeoNames has 18,937 AT rows; the gazetteer has 809. Same lever as PL/CZ, just not yet run.
3. **Rooftop precision** — the 50-state US street tier (#735) and interpolation coverage are the path from @25km parity to @1km competitiveness.
4. **Span-rescore v2** — always-recover + fitted calibration dissolves the flag, makes the recovery transparent to consumers.

### What's healthy

- The eval discipline: benchmark → classify → drill-down → fix. No hunch-driven work.
- The resolver lever contract: default-off, byte-stable, tested, measured before promotion.
- The honesty about limitations: centroid-vs-rooftop, AU drag, @1km gap — all stated plainly.
- The blog voice: technical, self-critical, doesn't flatter.

### What needs attention

- #208 (G-NAF) needs to be tracked visibly — it's the highest-ROI lever with no open issue.
- The blog post should be un-drafted and published.
- haversineKm consolidation (low priority, consistency cleanup).
- The `alternatives` type-cast documentation (low priority, defensive).

---

## Bottom line

The branch ships measured, honest improvements that take mailwoman from "US champion" to "European competitive." The code is disciplined: every lever is default-off, byte-stable, tested, and validated against real coordinates before promotion. The eval tooling is a pipeline, not a collection of scripts. The remaining gaps — AU word-order, AT postcode coverage, rooftop precision — are all characterized with measured ceilings and named next steps.

The project is in good shape. The highest-value next action is unblocking the AU fix (G-NAF training data) and publishing the incumbent-comparison blog post. The centroid-vs-rooftop trade is the honest framing; don't let marketing pressure blur it.
