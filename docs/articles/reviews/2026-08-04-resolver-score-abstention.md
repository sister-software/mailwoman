# resolver_score cannot gate garbage — a characterization

**Date:** 2026-08-04 · **Issue:** #40, mailfail finding 5 · **Scope:** what `metadata.resolver_score` is, what it can
and cannot decide, and what an abstention surface would have to be built on instead.

This is a **characterization only**. No scoring code was changed, and none of the designs at the end were implemented.
Everything numeric here was re-measured today against the committed fixture
(`mailwoman/eval-harness/fixtures/mailfail.jsonl`, 105 rows) plus a real-address control
(`data/eval/external/oa-us-coord-150.jsonl`, 150 US addresses with government coordinates), on both resolver backends.

---

## Verdict in one paragraph

`resolver_score` is not one number. On the FTS backend it is a negated bm25 plus about six points of additive tiers;
on the candidate backend it is exactly `log10(population + 1)`. The two live on scales that do not overlap
(FTS localities 9–44, candidate localities 0–7), and within the FTS backend a second code path returns a bounded
`[0, 1]` blend instead. Its own type says so: _"Scale is implementation-defined; callers should treat as ordinal."_
So the interesting question is not "what threshold abstains" but **"is this number ordinal within one query, or is it
a magnitude you can compare across queries?"** — and the answer is the former. Measured on the fixture, a single
score threshold separates a correct locality from a garbage locality with Youden J = 0.357 (FTS) / 0.573 (candidate).
The classifier's own span confidence, already on the same node and already in `[0, 1]` for both backends, gets
J = 0.929 / 0.917 on the same populations. **The signal that abstains is upstream of the resolver.**

---

## 1. Where the number comes from

`resolver/resolve.ts:1119` is the only place it is written, and it copies the backend's value verbatim:

```ts
node.metadata = { ...node.metadata, resolver_score: resolved.score, resolver_name: resolved.name }
```

There is no normalization, calibration, or clamping between the backend and that line.

### FTS backend — `resolver-wof-sqlite/lookup.ts`

Two distinct regimes, chosen per query.

**Regime A (the normal path), `lookup.ts:756-843`.** `bm25(place_search) AS rank` from the FTS5 query, negated, plus
additive tiers:

```ts
// SQLite's bm25() returns a lower-is-better score (negative for matches). Negate so we
// start from a higher-is-better baseline.
let score = -row.rank
```

then `+0.5` placetype match, `+0.2` implicit locality, `+0.3` country match, `+0.5`/`+0.2` direct-child/descendant,
`−0.1 × extraLen/10` length penalty, up to `+0.8` proximity, up to `+4.0` population
(`resolver-wof-sqlite/ranking-weights.ts:119-148`). The bm25 base is unbounded and the whole additive stack tops out
around `+6.3`, which is why `exactMatchTiering` exists — the code's own note records **"BM25 gaps of 1.5-3.0 between
famous places and tiny same-name peers"**, i.e. the base term is noisy at exactly the scale the boosts operate on.
`exactMatchTiering` re-sorts by match tier first and uses this score only to break ties within a tier.

**Regime B (coordinate-first postcode path), `lookup.ts:1019-1146`.** A weighted blend of three `[0, 1]` terms:

```ts
score: w.pc * sPc + w.name * sName + w.pop * sPop // WORLD_DEFAULT weights { pc: 0.6, name: 0.3, pop: 0.1 }
```

Weights sum to 1, so **this score is bounded in `[0, 1]`** — a different scale from Regime A, out of the same backend,
on the same field.

### Candidate backend — `resolver-wof-sqlite/candidate-lookup.ts`

`neg_rank` is precomputed at build time as `-log10(pop + 1)` (`build-candidate.ts:176`), and:

```ts
// `score` stays the RAW population rank (`-neg_rank`) — it feeds the resolver walk's absolute
// `minWinningScore` gate (`resolve.ts`), which must see real prominence, never a penalized value.
score: -Number(row.neg_rank),          // candidate-lookup.ts:482
```

So `score = log10(population + 1)`, exactly. Two exceptions: a postal-city-exact hit short-circuits with a flat
`score: 1` (`candidate-lookup.ts:328`), and a place with no population data scores `0`. The bounded cross-country
primary preference (`PRIMARY_PREFERENCE_LOG10 = 1`) and the optional proximity re-rank both write `prominence`, never
`score`.

This is confirmed by measurement: every postcode node the candidate backend resolved in this run scored exactly `0.00`
(n=155 across garbage + control), and `Seoul` scored `7.01` — `log10(10.2M) ≈ 7.01`.

### Who consumes it today

Almost nobody, and nothing gates on it by default.

- `resolve.ts:1076` — `if (top.score < state.minWinningScore) return null`. This is the one true gate.
  `minWinningScore` defaults to `0` (`resolve.ts:757`) and **no production caller sets it** (grep: only
  `resolver/resolve.test.ts:311`). Its own docstring says _"Score scale is implementation-defined; tune per backend."_
- `resolver-wof-wasm/browser-cascade.ts:302` — a tiebreak _within_ a placetype-rank tier
  (`b.rank - a.rank || b.hit.score - a.hit.score`). Same backend, same query, so scale-consistent and safe.
- `core/pipeline/reconcile.ts:565` — `normalizeResolverScore` clamps to `(0, 1]` for a multiplicative beam combiner.
  Because both real backends routinely return scores above 1, this **saturates almost every candidate to exactly 1**,
  contributing "was there a match at all" and nothing else. It is on the joint-reconcile path, which is
  **default-OFF** (`runtime-pipeline.ts:479`, `jointReconcile ?? false`, retired as default 2026-06-14), so this is
  latent rather than live — but it is a trap waiting for whoever re-promotes that path.
- `mailwoman/geocode-core.ts` reads `primaryNode.alternatives` to build the geocode `candidates` array, and never
  reads the score. The API-facing `confidence` field comes from the coarse-country placer, not the resolver.

Everything else is observational.

---

## 2. What was measured, and how

Two runs per backend (105 garbage probes + 150 control addresses each), through the shipped
`createRuntimePipeline({ classifier, resolver })` with `locale: en-US`, capturing every node that came back carrying
coordinates: its tag, value, resolved place name, `resolver_score`, classifier confidence, alternatives count, the
distinct tags present in the whole parse, and (for the control) the great-circle error to the government point.

- FTS backend: `admin-global-priority.db` (5.3 GB, sealed, md5-stamped 2026-08-02). No postcode shard, so postcode
  nodes never resolve on this leg.
- Candidate backend: `candidate.db` → `candidate-global-1026.db` (1.65 GB, sealed).

Scripts live in the gitignored `scripts/diagnostic/` (`score-probe.ts`, `score-report.ts`, `score-bars.ts`,
`score-signals.ts`, `source-split.ts`, `conf-dist.ts`), following the same convention as the mailfail probe generator.

**Definitions, stated because the answer depends entirely on them:**

- A **garbage resolution** is any coordinate produced for a fixture row. A **violation** is narrower: a coordinate
  produced for a row whose committed `expect` bar is `no-resolve` (35 of the 105 rows carry that bar).
- A **correct control resolution** is a control locality node within 25 km of the government point. 25 km is
  deliberately loose because admin-centroid resolution legitimately misses an edge address by tens of km.

---

## 3. The reproduction, including what did not reproduce

### Resolve rates

| backend   | probes resolving ≥1 coordinate | `no-resolve` bar violated | resolved nodes |
| --------- | ------------------------------ | ------------------------- | -------------- |
| FTS       | 33 / 105                       | **14 / 35**               | 56             |
| candidate | 41 / 105                       | **18 / 35**               | 62             |

The mailfail report's headline was "35 of 110 probes produced at least one coordinate". Re-measured on the 105
committed rows that is 33 (FTS) — consistent, since the fixture drops the oversized `size` rows.

**The 33 is not 33 defects.** Nineteen of the resolving FTS probes carry a bar _weaker_ than `no-resolve`, and the
fixture is right to grade them that way: `﻿350 5th Ave, New York, NY` (leading BOM), `Café de Flore, Paris` (NFD
accents), `רחוב דיזנגוף 100, תל אביב`, the U+2028-separated address, the repeated-address size row, the CSV and YAML
rows that contain `New York`, and `Springfield` are **real place names inside awkward wrappers**. Resolving them is
correct behavior. Only the 14/35 `no-resolve` violations are the defect: `1` → Zona 1, `0` → Purwa 0, `a` → A,
`home` → Home, `Aug` → Aug, `boom` → Boom, `amet` → Amet, `all` → All, `null` → Null, `DROP` → Drop, `Quote` → Quote,
`NEAR` → Near Acres Estates. One row (`g76`, a SQL statement containing `'New York'`) carries `no-resolve` and
contains a genuine city name — that bar is arguably mis-set.

### Score distributions (locality nodes)

| population                          | FTS                                         | candidate                               |
| ----------------------------------- | ------------------------------------------- | --------------------------------------- |
| `no-resolve` violations             | n=14 mean **21.05** p50 23.92, 13.45–28.74  | n=12 mean **2.26** p50 2.65, 0.00–6.95  |
| correct control localities (≤25 km) | n=149 mean **25.63** p50 24.58, 18.73–43.98 | n=150 mean **4.47** p50 4.58, 0.00–6.44 |

Best single threshold, sweeping every observed score:

| backend   | threshold | keeps correct | drops violations | Youden J  |
| --------- | --------- | ------------- | ---------------- | --------- |
| FTS       | ≥ 18.73   | 100.0%        | 35.7%            | **0.357** |
| candidate | ≥ 3.67    | 74.0%         | 83.3%            | **0.573** |

Nine of the 14 FTS violations score above the _lowest-scoring correct_ control locality. That is the finding, stated
without the sign confusion: **there is no threshold on this field that separates the two populations**, and the
thresholds that do best are different numbers on different backends because the scales are different.

### What did NOT reproduce

The framing this task arrived with was that **wrong answers score higher than right ones** — FTS 25.67 vs 24.33,
candidate 6.52 vs 6.07. On the definitions above, that inequality does not hold: correct localities score _higher_
than garbage localities on both backends (25.63 vs 21.05; 4.47 vs 2.26).

The sign flips when you pool tags. Grading every resolved node by distance-to-truth, on the candidate backend:

```
control right <=25km   n=323 mean=2.53
control wrong  >25km   n=127 mean=6.43     <- "wrong scores higher"
```

That "wrong" bucket is 125 **region** nodes and 2 postcode nodes. A region node that resolves California correctly
still sits 200 km from a Mill Valley address, so distance grading marks it wrong; and region rows carry the highest
scores on that backend (5.31–7.59, vs 0.00–6.44 for localities and a flat 0.00 for postcodes). The pooled statistic
is therefore **dominated by tag, not by correctness** — 6.43 is close to the 6.52 in the original claim, which makes
this the likely mechanism behind it.

That is not a correction that rescues the score. It is a second, independent reason not to threshold on it:
`resolver_score` is not comparable across tags _within_ one backend, let alone across backends. Any pooled mean over
this field is measuring composition.

### The scale table, which is the whole argument

| backend   | locality     | region       | postcode      |
| --------- | ------------ | ------------ | ------------- |
| FTS       | 9.11 – 43.98 | 4.80 – 28.98 | (not wired)   |
| candidate | 0.00 – 7.01  | 5.31 – 7.59  | 0.00 (always) |

A threshold of `5` means "reject nearly everything" on FTS and "accept most cities" on candidate. A threshold of `20`
is unreachable on candidate. There is no shared unit.

---

## 4. What separates the two populations, since the score does not

Same populations, same runs, other fields already present on the node:

| signal                                    | FTS J        | candidate J  | note                                                       |
| ----------------------------------------- | ------------ | ------------ | ---------------------------------------------------------- |
| `resolver_score`                          | 0.357        | 0.573        | backend-specific scale; no shared threshold                |
| **classifier span confidence**            | **0.929**    | **0.917**    | already `[0, 1]`, already on the node, backend-independent |
| corroboration (another component present) | drops 7/14   | drops 6/12   | costs 0 on this control — but see the caveat               |
| alternatives count                        | 1.50 vs 1.50 | 2.33 vs 0.81 | no signal on FTS; some on candidate                        |

Confidence detail (FTS leg):

```
violations  n=14  min=0.062  p50=0.500  max=0.964
correct     n=149 min=0.918  p50=0.928  max=0.945
```

At a 0.918 cut, 13 of 14 violations drop and no correct control locality is lost. The single survivor is
`+1 (555) 867-5309` → `1` → Zona 1 at **0.964**, the highest-confidence violation in the set — a phone number that
the model is more sure about than any real address it read.

**Three caveats, because the numbers above are seductive:**

1. The correct-control confidence band is _absurdly_ tight (0.918–0.945 across 149 addresses). A signal that
   near-constant on clean structured US input will spread on a harder control, and the 0.918 cut is nothing more than
   the minimum of that cluster. Any threshold work must re-derive this on a multi-locale, fragment-shaped control
   before it means anything.
2. Corroboration costs "0 of 149" only because every control row is a full street address. `Springfield` — a bare
   city name a user genuinely types, and a row in this very fixture — is uncorroborated by construction. A
   corroboration-only rule would delete the bare-locality search path, which is the map-search register the product
   is aimed at.
3. n=14 and n=12. These are directional results on a small violation set, not calibrated numbers.

Fields already on `ResolvedPlace` that nothing currently reads at the gate site, and that a design could use:
`exactMatch` (match-quality tier — already the primary sort key elsewhere), `prominence` (bounded ~`[0, 8]`, defined
the same way on both backends, and therefore a far better candidate for a shared threshold than `score`), `mismatch`
(an explicit postcode/locality conflict flag), `resolutionQuality` (an explicit fallback-tier flag), and the
top-vs-runner-up score _margin_, which is computed nowhere today even though `alternatives` is retained.

---

## 5. Three candidate designs for an abstention surface

Presented in ascending order of cost. None of them is a recommendation; each carries what would have to be measured
to promote it.

### Design A — per-backend calibration of the existing gate

Keep `resolver_score` as-is. Give `minWinningScore` a per-backend default, sourced from the backend rather than the
caller: a `scoreProfile` on the `PlaceLookup`/`ResolverBackend` interface declaring `{ scale: "bm25" | "log10pop" |
"unit", abstainBelow: number }`, which `resolveTree` reads instead of the current `opts.minWinningScore ?? 0`.

- **Cost.** Small and contained: one optional interface field, one line in `resolve.ts:1076`, two backend
  implementations. No new features, no model work, no artifact rebuild.
- **What it buys.** At the measured optimum it drops 36% (FTS) / 83% (candidate) of `no-resolve` violations. The
  candidate number is decent; the FTS number is not.
- **What it does not buy.** It cannot fix the tag-incomparability — `5.31` is a plausible region and an implausible
  locality on the same backend — so the profile would really need to be per-`(backend, placetype)`, and by then you
  are hand-tuning six constants against a 14-row violation set.
- **Evidence required to promote.** A per-backend, per-placetype threshold sweep on a violation set 10× this one,
  plus a no-regression run on the fragment boards and the gauntlet (the bare-locality and homonym rows are exactly
  what a score floor kills). The D-rule applies: default-on with a known tier-1 regression is not shippable.
- **Assessment.** This is the cheapest thing that could work and the one most likely to be re-tuned forever. The
  measurement above says the ceiling is low on the FTS backend.

### Design B — abstain on a separate, backend-independent feature set (do not touch scoring)

Leave `resolver_score` alone permanently — accept that it is ordinal-within-query — and add an explicit
`abstention` decision computed from features that already exist and are already on a shared scale: classifier span
confidence, `exactMatch`, corroboration (does the parse carry a house number / street / postcode / unit?),
`prominence`, `mismatch`, and the top-vs-runner-up margin. Surface the outcome as structured metadata
(`resolution_abstained` + reason) rather than by suppressing the coordinate, so consumers choose the policy — matching
the `postcode_city_mismatch` / `resolution_quality` idiom already in `decorateNode`, and matching what the #40
`PipelineResult.faults` work landed today (report the degrade; do not silently change the answer).

- **Cost.** Medium. A new decision function in `@mailwoman/resolver` plus plumbing for two features the resolver
  cannot currently see (the classifier's span confidence is on the node, so that one is free; corroboration needs the
  whole tree, which `resolveTree` already walks). No model retrain, no artifact rebuild, no backend change.
- **What it buys.** On the measured signals, confidence alone separates at J ≈ 0.92 on both backends with a single
  shared threshold — an order of magnitude better than any score threshold, and it works identically on both
  backends because the feature is upstream of them.
- **Risk.** The confidence band on clean input is suspiciously tight, so the first shippable version of this is
  **advisory metadata with no default suppression** while the threshold is calibrated on real traffic-shaped input.
  Shipping a suppression rule off a 149-row control would be exactly the "reasoned to instead of measured" failure
  the house rules warn about.
- **Evidence required to promote.** (1) The confidence distribution re-derived on a multi-locale control including
  fragments, bare localities, and non-Latin scripts — does the 0.918 floor survive? (2) A held-out violation set
  ≥150 rows, ideally mined from real queries rather than authored. (3) Fragment-board + gauntlet no-regression with
  the rule advisory-only, then again with it enforcing. (4) An explicit answer for the one case a confidence rule
  misses: high-confidence single-token digit localities (`1` → Zona 1 at 0.964), which probably wants the
  corroboration feature rather than the confidence one.

### Design C — normalize the score into a shared unit

Replace the raw pass-through with a calibrated, backend-declared `[0, 1]` score: each backend maps its native scale
to a probability-like quantity (FTS via a fitted logistic on bm25 + tiers; candidate via
`min(1, log10(pop+1) / 9.15)` or a fitted equivalent), and `resolver_score` ships the calibrated value with the raw
one preserved beside it as `resolver_score_raw`.

- **Cost.** High, and it is the only option with a compatibility surface: `resolver_score` is a published metadata
  field, `browser-cascade.ts` tiebreaks on it, and `reconcile.ts` clamps it. Changing its meaning is a breaking
  change to a shipped contract, so it wants a major.
- **What it buys.** One threshold that means the same thing everywhere, and it repairs `normalizeResolverScore`'s
  saturation as a side effect (a calibrated `[0, 1]` score is exactly what that combiner was written expecting).
- **What it does not buy.** Calibration does not create separation. On the measured data the _ordering_ is barely
  separating; a monotone remap of a barely-separating signal is a barely-separating signal in nicer units. Design C
  is a prerequisite for cross-backend comparison, **not** a solution to abstention.
- **Evidence required to promote.** A held-out calibration set per backend (score → observed correctness rate), a
  reliability curve showing the calibrated value is actually a probability, and a demonstration that the ordering
  survives the remap on the resolver evals. Plus the usual major-version consumer sweep.

**If you only take one thing:** Designs B and C are complementary, not alternatives, and B does not depend on C.
Design C makes the number comparable; Design B makes the decision possible. Doing C alone would produce a
well-calibrated number that still cannot abstain.

---

## 6. What was not tested

- **One locale.** `en-US` weights, US control set. The confidence distribution is a model property and will differ
  per locale; the score scales are backend properties and will not.
- **One control shape.** All 150 control rows are full US street addresses. No bare localities, no fragments, no
  non-Latin script in the _control_ (there is some in the garbage set). The corroboration signal's zero measured cost
  is an artifact of that shape and should not be quoted without this caveat.
- **No FTS postcode shard.** The FTS leg ran against the admin database alone, so it produced no postcode nodes and
  never exercised the coordinate-first Regime B scorer. The `[0, 1]` regime is read from source, not measured.
- **No calibration fitting.** Design C's mappings are sketches. No logistic was fitted, no reliability curve drawn.
- **No `prominence` measurement.** It is argued for on the strength of its definition (bounded, same meaning on both
  backends) rather than a measured separation — it was not captured in these runs. That is a one-line probe change
  and should be the first thing anyone does before adopting Design A or B.
- **Small violation set.** 14 (FTS) / 18 (candidate) rows clear the `no-resolve` bar. Every J above should be read
  as directional.
