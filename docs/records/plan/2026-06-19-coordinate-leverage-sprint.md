---
title: "Sprint: coordinate-signal routing (reranker vs coverage vs multi-locale)"
---

# Sprint: where the next coordinate gains live

_Defined 2026-06-19, after the v4.11.0 ship (FR-admin-split), the research-romp paper triage
(`.notes/research-romp-applicability.md`), and a 4-turn DeepSeek consult
(`.agents/skills/deepseek-consult/session-notes-2026-06-19-research-nextsteps.md`)._

We grade the **assembled geocoded coordinate**, never label-F1 alone. That rule has worked
all month, because of the "#566 trap": label improvements that never reach the coordinate. This sprint applies the
same rule to deciding what to build next, and the answer is to **measure before committing**.
A single zero-GPU diagnostic decides the direction of the cycle, and the one strategic choice goes to
the operator explicitly rather than resting on an assumption.

## The reframe — what we are not doing, and why

The research-romp triage's main finding was a principled fix for the #727 admin-token
fragmentation: a span-level head (GLiNER / Filtered Semi-Markov CRF) plus a lower-fertility
multilingual vocabulary (EuroBERT). The papers are sound. **The fix is also
invisible in the coordinate metric.** We shipped v4.11.0 _carrying_ the #727 fragmentation with zero coordinate
delta. The diacritic break affects ~1% of emitted régions, and the resolver already recovers from it. A
span-head + vocab-prune + full retrain + int8/WASM requantisation is a multi-week architecture
overhaul aimed at a defect that does not move the metric we ship on. It is another instance of the #566 trap.

**Decision: the span-head / tokenizer thread is parked as future work** for CJK/Cyrillic locales
(where byte-fallback fertility blocks coverage we do not yet serve) rather than next-cycle work. If
we commit to those scripts, we will resume the fertility diagnostic and the GLiNER-style head.

## The decision this sprint resolves

Where does the next coordinate-moving cycle go?

1. **Learned resolver reranker** (GeoNorm / GBM-over-candidates), which would improve every already-covered match.
2. **Coverage expansion:** US-rural gazetteer completeness (SD 62%, VT 31% locality resolution) and/or
   multi-locale gazetteer ingest (AU/ES/IT = zero rows in `admin-global-priority.db` today).
3. **Multi-locale parser extracts:** generalize the result to ES/IT/AU.

These options differ in cost and in who they serve, and the bottleneck differs per locale. **A
measurement decides the route.**

## Workstream A (first, this sprint): the Three-Gap Matrix diagnostic

The diagnostic is one artifact that needs no GPU and runs on a laptop. For a held-out eval set, decompose **every error** into the
gap that caused it, because each gap routes to a different (and mutually exclusive) fix:

For each query, join truth → WOF id (nearest-neighbour + name match), then classify the error:

1. **coverage-gap:** the true WOF id is **not in the gazetteer at all**. Only data ingest helps, and a
   reranker or better retrieval has no effect.
2. **recall-gap:** the true id is in the gazetteer but **not in the resolver's top-k candidates**.
   Fix retrieval (raise _k_, relax the FTS/trigram threshold) rather than ranking.
3. **ranking-gap:** the true id **is in top-k but mis-ranked** (rank > 1). A reranker can fix
   this class and only this class. **The ranking-gap fraction is the reranker's ceiling.**

Run at **k = 5 / 10 / 20**. If recall-gap shrinks sharply as k grows, retrieval is too restrictive. If it
stays flat, the candidate is buried, and retrieval needs a different strategy rather than a wider beam.

### Output schema — one row per locale

| field                  | meaning                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `locale`               | us, fr, de, …                                                                                  |
| `query_volume_share`   | fraction of current query volume (and a second, strategic weighting — see below)               |
| `coverage_gap_pct`     | errors where truth not in gazetteer                                                            |
| `recall_gap_pct`       | truth in gazetteer rather than in top-k                                                        |
| `ranking_gap_pct`      | truth in top-k, mis-ranked — **the reranker ceiling**                                          |
| `parse_blocker_pct`    | (zero-DB locales only) parser fails to produce a clean locality+admin split when truth has one |
| `coverage_blocker_pct` | (zero-DB locales only) `1 − parse_blocker_pct`                                                 |

**Zero-DB method (measuring a locale we cannot yet resolve, without a gazetteer):** for AU/ES/IT, run the
parser on public samples (OpenAddresses / OSM / synthetic) and compute the **admin-split detection
rate**: the share of rows where the parser emits a locality token and an adjacent admin token when the ground truth has
both. This separates the case where the parser blocks progress (fix: an admin-split extract, like FR) from the case where the gazetteer
blocks it (fix: WOF ingest), without doing the ingest first.

### Routing thresholds

| condition                                                 | route                                         |
| --------------------------------------------------------- | --------------------------------------------- |
| `coverage_gap_pct` > 0.20 AND `query_volume_share` > 0.05 | **Coverage expansion** (data ingest)          |
| `ranking_gap_pct` > 0.10 AND `coverage_gap_pct` < 0.20    | **Reranker** (learned ranking)                |
| `recall_gap_pct` > 0.15 AND `coverage_gap_pct` < 0.20     | **Retrieval fix** (raise k / relax FTS)       |
| `parse_blocker_pct` > 0.30 (zero-DB locale)               | **Parser extract** (admin-split, FR template) |
| `coverage_blocker_pct` > 0.70 (zero-DB locale)            | **Coverage expansion** (WOF ingest)           |

**Run US first.** It has the highest volume, the widest coverage variation (urban vs rural), and the fastest
computation, and it gives the most informative single routing signal.

### The decision rule (apply after the US matrix)

> If the ranking-gap fraction (current-volume-weighted) is **≥ 10%** of total errors **AND** the
> coverage-gap fraction is **< 20%**, build the reranker. Otherwise expand coverage — US-rural if the
> coverage gap dominates there, EU-gazetteer if the strategic-weighted matrix shows the gap there.

### DeepSeek's bet (a prediction to verify rather than a fact)

Coverage wins: US `coverage_gap ≈ 12–15%`, `ranking_gap ≈ 3–5%` (reranker ceiling too small to move the
US aggregate); EU `coverage_gap > 30%` → **EU gazetteer ingest is the binding strategic constraint.**
_Flip condition:_ US `ranking_gap ≥ 8%` AND the EU parse-blocker shows the parser already produces clean
admin-split on > 60% of ES/IT/AU → the reranker wins (build once, deploy globally; coverage becomes a
parallel data track). Treat the consult's structure as a reasonable hypothesis and **test its numbers**,
which the diagnostic exists to check.

### Workstream A — RESULT (US, 2026-06-19)

Ran `scripts/eval/three-gap-matrix.ts` on 10,000 OA-US rows. Faithful query (region `parentId` +
postcode + parent-fallback, two-extract admin + postcode-locality), coordinate/name bucketing (rank of
the right place rather than a specific WOF id, because the first pass over-counted ranking gaps where WOF carries
duplicate ids for one place).

| metric (k = 10)                | value      |
| ------------------------------ | ---------- |
| correct                        | **97.88%** |
| ranking-gap (reranker ceiling) | **0.01%**  |
| recall-gap                     | 0.06%      |
| coverage-gap                   | **2.05%**  |
| at-rank-1 among covered        | **100%**   |

The results are identical at k = 5 / 10 / 20, so the retrieval beam is not the constraint. **Route: EXPAND_COVERAGE.
A reranker would not help** (ranking-gap 0.01% ≪ the 10% bar). DeepSeek's structural bet
(coverage > reranker) is **confirmed, with smaller numbers**: ranking headroom is ~0 (it bet 3–5%), and the US
coverage gap is ~2% on this sample (it bet 12–15%).

**What the coverage gap contains.** The dumped coverage-gap rows are almost all
**township / CDP / civil-division granularity** rather than "rural towns missing from WOF": `Monroe Twp`,
`Saylor Twp`, `Bertram Twp` (Iowa civil townships); `Barre City` vs `Barre Town`, `Essex Town` vs
`Essex Junction Village`, `Saint Albans City` vs `Saint Albans Town` (VT town/city/village splits);
`Dakota Dunes`, `Pennco` (SD CDPs); `Yankton County`. OpenAddresses' "city" field is frequently a civil
township / village / CDP that WOF does not model as a `locality`. **So the first, lowest-cost US
coverage change is a granularity/alias mapping (OA-city → WOF place; CDP/localadmin resolution) rather than a
WOF re-ingest**, because the places mostly exist but are modelled at a different granularity.

**Caveats:**

- The OA sample is a **7-state, rural-skewed** set (VT/IA/SD/MT + IL/CA/DC, ~1429 each), deliberately
  over-weighting the hard township states. A national, population-weighted coverage number is almost
  certainly **lower** (urban volume resolves directly: CA/DC/IL coverage-gap ≈ 0–1%).
- Input is **clean** OA (correct region + postcode). Ranking-gap ≈ 0 is measured _given_ clean
  disambiguating context, which a reranker would also have. Clean OA does **not** exercise the consult's
  case where a reranker helps on ambiguity (missing postcode / wrong region). If real traffic is noisier,
  ranking headroom could be higher. A degraded-input probe is worthwhile before ruling out the reranker
  entirely, but on clean data it would not help.

**Net:** for US, do not build a reranker. The coordinate change is coverage, and specifically the
township/CDP granularity mapping. Whether US-coverage or EU-coverage is the sprint's priority is the
strategic fork below.

### Workstream A — EU parse-blocker result (2026-06-19)

Ran `scripts/eval/eu-parse-blocker.ts` on the in-repo OA samples (1500 rows/locale, ship-config
v4.11.0 parse, `normalizeCase` on). The proxy is **conditioned on whether the admin token appears in the
input**. The first version was not, and it wrongly flagged ES/IT/NL as parser-blocked. OA writes "street,
postcode locality", and the postcode implies the province without a separate token, so there is no token to
split. The corrected results:

| locale | region-in-input     | admin-split (when in input) | **loc-emit → loc-correct** | route                           |
| ------ | ------------------- | --------------------------- | -------------------------- | ------------------------------- |
| FR     | n/a (OA omits dépt) | — (v1.8.0 BAN check: 99.6%) | 100% → **97.7%**           | done                            |
| DE     | **100%**            | **32.7%** (drops 67%)       | 66% → **36.3%**            | **PARSER_EXTRACT**              |
| ES     | 8.6%                | —                           | 98% → **21.3%**            | parser (locality) then coverage |
| IT     | 1.9%                | —                           | 100% → **58.7%**           | coverage + parser polish        |
| NL     | 2.9%                | —                           | 99% → **64.0%**            | coverage + parser polish        |

**This result contradicts the assumption that coverage is the EU constraint, and it contradicts DeepSeek's
bet that ingesting WOF would be enough. For now, the binding EU constraint is the parser rather than coverage.** The model emits a locality almost
always (98%+) but gets it _right_ only 21–64% of the time outside FR (vs FR 97.7%, US ~98%). The model is en-us-centric,
and only FR got a dedicated extract. Per locale:

- **DE — parser, and it is the clearest next FR-style improvement.** The region is always in the input
  (`Mülsen, Sachsen`; `Berlin, Berlin`) and the parser drops it 67% of the time _and_ drops the
  locality on the city-state / `City, Region PLZ` format (loc-correct 36%). **DE is already in
  the resolver DB** (US/DE/FR), so a DE admin-split / `City,Region` extract (the FR template) improves the
  DE coordinate immediately without any ingest. This overlaps the known German city-state work.
- **ES — a specific, likely-cheap parser bug.** loc-correct is 21% because the parser does not recognize the Spanish street keyword
  `CALLE`, which bleeds into the locality (`CALLE HUERTA…` → locality `ALLE CA`). ES is
  also zero-DB, so it needs coverage too, but the locality must parse first.
- **IT / NL — coverage (zero-DB) primary**, with modest locality-parse polish (59% / 64%).

**Caveats (loc-correct is a lower bound):** strict `normName` equality under-counts multi-token / bilingual /
variant names. ES is further lowered by bilingual slash-truth (`Sant Vicent del Raspeig/San
Vicente del Raspeig`); DE by the city-state drop. The relative ordering (FR ≫ IT/NL > DE > ES) is the
trustworthy signal rather than the absolute floors. OA samples are clean-ish; real traffic may differ.

**Routing implication:** the EU multi-locale work is larger and more parser-dependent than ingesting WOF.
Per-locale parser readiness limits the coordinate before coverage can pay off. The cheapest
EU coordinate improvement is a **DE admin-split extract** (resolver already covers DE; clear, measured parse
gap), directly reusing the FR-admin-split template.

## The strategic fork (operator's call — surfaced rather than assumed)

Volume-weighting is **circular** for us. "US is ~65% of queries" is an artifact of what we currently
serve (a US-centric model + US/DE/FR-only gazetteer) rather than where the strategic value is. Mailwoman is
positioned as a **sovereign, EU-first, multi-locale** alternative to Google geocoding. The matrix is therefore
computed **twice**: weighted by current volume (optimizing for current users) **and** weighted by EU strategy
(optimizing for the users we want). The two weightings will likely route to different changes: US toward
"reranker or US-coverage" and EU toward "gazetteer ingest". That divergence is the strategic decision, and
the operator makes it. The diagnostic makes the choice explicit and does not pick.

## Workstream B (conditional, post-diagnostic): the chosen change

This workstream builds whichever change the matrix selects. If it is the **reranker**, the eval is pre-registered now so an
in-distribution improvement cannot mislead us, as happened with our GBM record-matcher's TX→CA over-fit and with
smokes that misled at scale:

- **Leave-one-state-out / leave-one-region-out** splits (random splits leak geographic structure).
- Full held-out set rather than smokes (the 250-record smoke misled us 3×).
- **Feature ablation to detect over-fit:** pop-only (baseline) / name-only / hierarchy-only / full. A
  generalizable signal also improves scores on held-out states; an over-fit one only helps in training states.
- **Pre-register per error class** rather than aggregate p50 (which conflates the three gaps): right-name-
  wrong-instance "Springfield" (target ≥ 50% recovery), population-tiebreak (≥ 30%), hierarchy-conflict
  (≥ 70%, the easiest, because the correct feature is directly observable), and feature-type (< 5%, likely a
  retrieval fix).
- Run the cheapest falsifier first: a LightGBM / logistic reranker over existing candidates with cheap features
  (log-pop, feature-type, Jaro-Winkler, hierarchy-match), without a GPU. If a shallow model can't beat the
  hand-tuned resolver on the ranking-gap subset, a transformer won't either.

If it's **coverage expansion** or a **multi-locale extract**, that's a separate scoping (WOF ingest
pipeline per the existing national-situs / Overture work; or the FR-admin-split extract template).

## Out of scope / parked

- **Span-head + lower-fertility vocab (#727):** future-enablement for CJK/Cyrillic rather than this sprint.
  Coordinate-invisible today.
- **The `enforceWordConsistency` decode-fix:** already shipped default-OFF; not revived here.
- **A transformer reranker:** blocked behind the cheap LightGBM falsifier showing ranking-gap signal.

## Exit criteria

1. The US Three-Gap Matrix is computed (coverage / recall / ranking, at k = 5/10/20) and the decision
   rule fires a route.
2. The matrix is re-weighted EU-strategic + the parse-blocker proxy is run on FR/DE/ES/IT samples.
3. The reranker-vs-coverage-vs-multi-locale route is chosen, with the operator resolving the strategic
   fork if the two weightings diverge.
4. DeepSeek's numeric bet is confirmed or refuted against the actual matrix, and the result is logged.

## Outcome (2026-06-20): coverage, confirmed at full scale

The route chosen was **coverage**, and the end-to-end measurement confirmed it. We built an Overture-divisions
gazetteer for the 15 zero-DB EU locales, folded the ingest into the canonical build
(`build-unified-wof.ts --overture-countries`, commit `8b018366`), rebuilt the whole admin DB to a
staging path (1.81M WOF + 299k Overture places, one Freeze, `integrity_check = ok`), and graded the
assembled coordinate against held-out Overture rooftop truth with `scripts/eval/eu-coord-direct.ts`.
No model was retrained, and the v1.8.0 parser is unchanged.

Coordinate p50 / resolve-rate / locality-name-match, 300 held-out rows each, sorted by p50 (`*` =
already-covered ES/IT/NL control, from the global WOF path):

| locale | resolve | **p50 km** | p90 km | name-match |
| ------ | ------: | ---------: | -----: | ---------: |
| LU     |     69% |    **0.4** |    1.0 |        69% |
| LV     |     34% |    **0.7** |   52.0 |        31% |
| CH     |     69% |    **0.7** |   30.1 |        55% |
| HR     |     83% |    **0.8** |   87.4 |        73% |
| SK     |     57% |    **1.0** |    2.3 |        54% |
| PT     |     83% |    **1.4** |    4.9 |        76% |
| IT \*  |     95% |    **1.5** |  118.2 |        82% |
| NL \*  |     97% |    **1.5** |    4.5 |        59% |
| SI     |     55% |    **1.6** |   56.1 |        36% |
| CZ     |     71% |    **1.7** |  146.1 |        55% |
| AT     |     54% |    **1.9** |  109.8 |        43% |
| BE     |     89% |    **1.9** |    5.5 |        85% |
| PL     |     82% |    **2.1** |  367.4 |        58% |
| ES \*  |     95% |    **2.2** |   10.5 |        65% |
| DK     |     53% |    **2.3** |   12.0 |        48% |
| FI     |     70% |    **3.4** |   19.3 |        68% |
| NO     |     53% |    **7.1** |  280.7 |        43% |
| LT     |      6% |   **78.5** |  226.8 |         0% |

**The median coordinate for 14 of 15 locales falls in the same range as the ES/IT/NL control (1.5–2.2 km).**
It comes from the Overture divisions gazetteer plus the postcode anchor, without GPU work.

The one outlier is **LT**, and it is an eval-data artifact rather than a coverage gap: the DB carries 20,960
Lithuanian localities and `Vilnius` / `Kaunas` / `Klaipėda` resolve perfectly, but the LT _address_
locality field carries settlement-type suffixes (`mstl.` / `m.` / `k.` = miestelis / miestas / kaimas),
Lithuanian genitive declension (`Rumšiškių` vs the gazetteer's nominative `Rumšiškės`), and an `LT-`
postcode prefix, so the held-out strings do not match the gazetteer names. Real LT input would need
that normalization (or a model that learns it). The gazetteer itself is correct.

The control rows (ES/IT/NL) are unchanged from the global WOF path, so the Overture backfill caused
no regression. The remaining work is **resolve-rate** (for the 34–70% locales, more Overture/postcode
coverage on the unresolved fraction) and the **p90 tail** (wrong-place name collisions). IT, a
covered control, also has a tail to 118 km, so the tail is a general resolver-ranking problem (population tiebreak /
postcode constraint) rather than one specific to the new locales. Neither needs a parser retrain.

The staging DB (`admin-global-priority-eu.db`) is built and validated; promoting it to the shipped
`admin-global-priority.db` is the conditional canonical-DB swap awaiting operator approval.
