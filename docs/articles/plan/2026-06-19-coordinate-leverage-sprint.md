---
title: "Sprint: coordinate-leverage routing (reranker vs coverage vs multi-locale)"
---

# Sprint: where the next coordinate gains live

_Defined 2026-06-19, after the v4.11.0 ship (FR-admin-split), the research-romp paper triage
(`.notes/research-romp-applicability.md`), and a 4-turn DeepSeek consult
(`.agents/skills/deepseek-consult/session-notes-2026-06-19-research-nextsteps.md`)._

We grade the **assembled geocoded coordinate**, never label-F1 — the discipline that has paid off
all month (the "#566 trap": label wins that never reach the coordinate). This sprint applies that
discipline to the question "what do we build next," and the answer is **measure before you commit**:
a single zero-GPU diagnostic routes the entire cycle, with the one genuinely strategic choice surfaced
for the operator rather than buried in an assumption.

## The reframe — what we are NOT doing, and why

The research-romp triage's headline finding was a principled fix for the #727 admin-token
fragmentation: a span-level head (GLiNER / Filtered Semi-Markov CRF) plus a lower-fertility
multilingual vocabulary (EuroBERT). It is good work and the papers are right. **It is also
coordinate-invisible.** We shipped v4.11.0 _carrying_ the #727 fragmentation with zero coordinate
delta; the diacritic break is ~1% of emitted régions, and the resolver already recovers past it. A
span-head + vocab-prune + full retrain + int8/WASM requantisation is a multi-week architecture
overhaul aimed at a defect that does not move the metric we ship on. That is the #566 trap wearing a
good-paper disguise.

**Decision: the span-head / tokenizer thread is PARKED as future-enablement** for CJK/Cyrillic locales
(where byte-fallback fertility genuinely blocks coverage we don't yet serve), not next-cycle work. If
and when we commit to those scripts, the fertility diagnostic + GLiNER-style head come off the shelf.

## The decision this sprint resolves

Where does the next coordinate-moving cycle go?

1. **Learned resolver reranker** (GeoNorm / GBM-over-candidates) — lifts every already-covered match.
2. **Coverage expansion** — US-rural gazetteer completeness (SD 62%, VT 31% locality resolution) and/or
   multi-locale gazetteer ingest (AU/ES/IT = zero rows in `admin-global-priority.db` today).
3. **Multi-locale parser shards** — generalize the FR-admin-split win to ES/IT/AU.

These are not equivalent in cost or in who they serve, and the bottleneck differs per locale. **We do
not guess — we route on a measurement.**

## Workstream A (first, this sprint): the Three-Gap Matrix diagnostic

One artifact, zero GPU, runs on a laptop. For a held-out eval set, decompose **every error** into the
gap that caused it, because each gap routes to a different (and mutually exclusive) fix:

For each query: join truth → WOF id (nearest-neighbour + name match). Then —

1. **coverage-gap** — the true WOF id is **not in the gazetteer at all** → only data ingest helps; a
   reranker and a better retrieval are both inert here.
2. **recall-gap** — the true id is in the gazetteer but **not in the resolver's top-k candidates** →
   fix retrieval (raise _k_, relax the FTS/trigram threshold), not ranking.
3. **ranking-gap** — the true id **is in top-k but mis-ranked** (rank > 1) → this, and only this, is
   what a reranker can fix. **The ranking-gap fraction is the reranker's ceiling.**

Run at **k = 5 / 10 / 20** (if recall-gap shrinks sharply as k grows, retrieval is too restrictive; if
flat, the candidate is buried and retrieval needs a different strategy, not a wider beam).

### Output schema — one row per locale

| field                  | meaning                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `locale`               | us, fr, de, …                                                                                  |
| `query_volume_share`   | fraction of current query volume (and a second, strategic weighting — see below)               |
| `coverage_gap_pct`     | errors where truth not in gazetteer                                                            |
| `recall_gap_pct`       | truth in gazetteer, not in top-k                                                               |
| `ranking_gap_pct`      | truth in top-k, mis-ranked — **the reranker ceiling**                                          |
| `parse_blocker_pct`    | (zero-DB locales only) parser fails to produce a clean locality+admin split when truth has one |
| `coverage_blocker_pct` | (zero-DB locales only) `1 − parse_blocker_pct`                                                 |

**The zero-DB trick (measure a locale we can't yet resolve, with NO gazetteer):** for AU/ES/IT, run the
parser on public samples (OpenAddresses / OSM / synthetic) and compute the **admin-split detection
rate** — does the parser emit a locality token and an adjacent admin token when the ground truth has
both? That isolates "the parser is the blocker (admin-split shard, like FR)" from "the gazetteer is the
blocker (WOF ingest)" without doing the ingest first.

### Routing thresholds

| condition                                                 | route                                       |
| --------------------------------------------------------- | ------------------------------------------- |
| `coverage_gap_pct` > 0.20 AND `query_volume_share` > 0.05 | **Coverage expansion** (data ingest)        |
| `ranking_gap_pct` > 0.10 AND `coverage_gap_pct` < 0.20    | **Reranker** (learned ranking)              |
| `recall_gap_pct` > 0.15 AND `coverage_gap_pct` < 0.20     | **Retrieval fix** (raise k / relax FTS)     |
| `parse_blocker_pct` > 0.30 (zero-DB locale)               | **Parser shard** (admin-split, FR template) |
| `coverage_blocker_pct` > 0.70 (zero-DB locale)            | **Coverage expansion** (WOF ingest)         |

**Run US first** — highest volume, widest coverage variation (urban vs rural), fastest to compute, and
the most informative single routing signal.

### The decision rule (apply after the US matrix)

> If the ranking-gap fraction (current-volume-weighted) is **≥ 10%** of total errors **AND** the
> coverage-gap fraction is **< 20%**, build the reranker. Otherwise expand coverage — US-rural if the
> coverage gap dominates there, EU-gazetteer if the strategic-weighted matrix shows the gap there.

### DeepSeek's bet (a prediction to verify, not a fact)

Coverage wins: US `coverage_gap ≈ 12–15%`, `ranking_gap ≈ 3–5%` (reranker ceiling too small to move the
US aggregate); EU `coverage_gap > 30%` → **EU gazetteer ingest is the binding strategic constraint.**
_Flip condition:_ US `ranking_gap ≥ 8%` AND the EU parse-blocker shows the parser already produces clean
admin-split on > 60% of ES/IT/AU → the reranker wins (build once, deploy globally; coverage becomes a
parallel data track). Consult calibration: trust the structure, **test the numbers** — these are the
numbers the diagnostic exists to check.

### Workstream A — RESULT (US, 2026-06-19)

Ran `scripts/eval/three-gap-matrix.ts` on 10,000 OA-US rows. Faithful query (region `parentId` +
postcode + parent-fallback, two-shard admin + postcode-locality), coordinate/name bucketing (rank of
the right PLACE, not a specific WOF id — the first pass over-counted ranking gaps because WOF carries
duplicate ids for one place).

| metric (k = 10)                | value      |
| ------------------------------ | ---------- |
| correct                        | **97.88%** |
| ranking-gap (reranker ceiling) | **0.01%**  |
| recall-gap                     | 0.06%      |
| coverage-gap                   | **2.05%**  |
| at-rank-1 among covered        | **100%**   |

Identical at k = 5 / 10 / 20 → the retrieval beam is not the constraint. **Route: EXPAND_COVERAGE —
the reranker is dead on arrival** (ranking-gap 0.01% ≪ the 10% bar). DeepSeek's structural bet
(coverage > reranker) is **confirmed and sharpened**: ranking headroom is ~0 (it bet 3–5%), and the US
coverage gap is ~2% on this sample (it bet 12–15%).

**The sharpening — what the coverage gap actually IS.** The dumped coverage-gap rows are almost all
**township / CDP / civil-division granularity**, not "rural towns missing from WOF": `Monroe Twp`,
`Saylor Twp`, `Bertram Twp` (Iowa civil townships); `Barre City` vs `Barre Town`, `Essex Town` vs
`Essex Junction Village`, `Saint Albans City` vs `Saint Albans Town` (VT town/city/village splits);
`Dakota Dunes`, `Pennco` (SD CDPs); `Yankton County`. OpenAddresses' "city" field is frequently a civil
township / village / CDP that WOF does not model as a `locality`. **So the first, lowest-cost US
coverage lever is a granularity/alias mapping (OA-city → WOF place; CDP/localadmin resolution), NOT a
WOF re-ingest** — the places largely exist, they're modelled at a different granularity.

**Honest caveats (do not over-read):**

- The OA sample is a **7-state, rural-skewed** set (VT/IA/SD/MT + IL/CA/DC, ~1429 each), deliberately
  over-weighting the hard township states. A national, population-weighted coverage number is almost
  certainly **lower** (urban volume resolves cleanly: CA/DC/IL coverage-gap ≈ 0–1%).
- Input is **clean** OA (correct region + postcode). Ranking-gap ≈ 0 is measured _given_ clean
  disambiguating context — which is exactly what a reranker would also have. The consult's
  reranker-helps-on-ambiguity case (missing postcode / wrong region) is **not** exercised by clean OA;
  if real traffic is noisier, ranking headroom could be higher. Worth a degraded-input probe before
  fully closing the reranker door, but on clean data it is unambiguously DOA.

**Net:** for US, do not build a reranker. The coordinate lever is coverage, and specifically the
township/CDP granularity mapping. Whether US-coverage or EU-coverage is the sprint's priority is the
strategic fork below.

### Workstream A — EU parse-blocker result (2026-06-19)

Ran `scripts/eval/eu-parse-blocker.ts` on the in-repo OA samples (1500 rows/locale, ship-config
v4.11.0 parse, `normalizeCase` on). The proxy is **gated on whether the admin token is actually IN the
input** (the first cut wasn't, and wrongly flagged ES/IT/NL as parser-blocked — OA writes "street,
postcode locality" and the province is implied by the postcode, NOT a token, so there is nothing to
split). Corrected:

| locale | region-in-input     | admin-split (when in input) | **loc-emit → loc-correct** | route                           |
| ------ | ------------------- | --------------------------- | -------------------------- | ------------------------------- |
| FR     | n/a (OA omits dépt) | — (v1.8.0 BAN gate: 99.6%)  | 100% → **97.7%**           | done                            |
| DE     | **100%**            | **32.7%** (drops 67%)       | 66% → **36.3%**            | **PARSER_SHARD**                |
| ES     | 8.6%                | —                           | 98% → **21.3%**            | parser (locality) then coverage |
| IT     | 1.9%                | —                           | 100% → **58.7%**           | coverage + parser polish        |
| NL     | 2.9%                | —                           | 99% → **64.0%**            | coverage + parser polish        |

**The finding overturns the simple "coverage wins for EU" narrative — and DeepSeek's "just ingest WOF"
bet. The binding EU constraint is the PARSER, not (yet) coverage.** The model emits a locality almost
always (98%+) but gets it _right_ only 21–64% outside FR (vs FR 97.7%, US ~98%). It's en-us-centric;
only FR got a dedicated shard. Per locale:

- **DE — parser, and it's the cleanest next FR-style win.** The region is always in the input
  (`Mülsen, Sachsen`; `Berlin, Berlin`) and the parser drops it 67% of the time _and_ drops the
  locality on the city-state / `City, Region PLZ` format (loc-correct 36%). Crucially **DE is already in
  the resolver DB** (US/DE/FR) — so a DE admin-split / `City,Region` shard (the FR template) moves the
  DE coordinate immediately, no ingest required. Overlaps the known German city-state work.
- **ES — a specific, likely-cheap parser bug.** loc-correct 21% because the Spanish street keyword
  `CALLE` isn't recognized and bleeds into the locality (`CALLE HUERTA…` → locality `ALLE CA`). ES is
  also zero-DB, so it needs coverage too — but the locality must parse first.
- **IT / NL — coverage (zero-DB) primary**, with modest locality-parse polish (59% / 64%).

**Caveats (loc-correct is a FLOOR):** strict `normName` equality under-counts multi-token / bilingual /
variant names — ES is additionally depressed by bilingual slash-truth (`Sant Vicent del Raspeig/San
Vicente del Raspeig`); DE by the city-state drop. The relative ordering (FR ≫ IT/NL > DE > ES) is the
trustworthy signal, not the absolute floors. OA samples are clean-ish; real traffic may differ.

**Routing implication:** the EU multi-locale bet is a bigger, more parser-shaped lift than "ingest WOF"
— per-locale parser readiness gates the coordinate before coverage can pay off. The lowest-friction
EU coordinate win is a **DE admin-split shard** (resolver already covers DE; clear, measured parse
gap), directly reusing the FR-admin-split template.

## The strategic fork (operator's call — surfaced, not assumed)

Volume-weighting is **circular** for us. "US is ~65% of queries" is an artifact of what we currently
serve (a US-centric model + US/DE/FR-only gazetteer), not where the strategic value is — mailwoman is
positioned as a **sovereign, EU-first, multi-locale** alternative to Google geocoding. So the matrix is
computed **twice**: current-volume-weighted (optimize the book we have) **and** EU-strategic-weighted
(the book we're trying to win). If the two weightings route to different levers — likely: US says
"reranker or US-coverage," EU says "gazetteer ingest" — that divergence is the strategic decision, and
it is the operator's to make. The diagnostic's job is to make it explicit, not to pick.

## Workstream B (conditional, post-diagnostic): the chosen lever

Whichever the matrix routes to. If it's the **reranker**, the eval is pre-registered now so an
in-distribution win cannot fool us (our GBM record-matcher's TX→CA over-fit + "smokes-mislead-at-scale"
scars):

- **Leave-one-state-out / leave-one-region-out** splits (random splits leak geographic structure).
- Full held-out set, **not** smokes (the 250-record smoke misled us 3×).
- **Feature-ablation as a lie detector:** pop-only (baseline) / name-only / hierarchy-only / full. A
  generalizable signal transfers across held-out states; an over-fit one only helps in training states.
- **Pre-register per error class**, not aggregate p50 (which conflates the three gaps): right-name-
  wrong-instance "Springfield" (target ≥ 50% recovery), population-tiebreak (≥ 30%), hierarchy-conflict
  (≥ 70%, the easiest — the correct feature is directly observable), feature-type (< 5%, likely a
  retrieval fix).
- Cheapest falsifier first: a LightGBM / logistic reranker over existing candidates with cheap features
  (log-pop, feature-type, Jaro-Winkler, hierarchy-match) — no GPU. If a shallow model can't beat the
  hand-tuned resolver on the ranking-gap subset, a transformer won't either.

If it's **coverage expansion** or a **multi-locale shard**, that's a separate scoping (WOF ingest
pipeline per the existing national-situs / Overture work; or the FR-admin-split shard template).

## Out of scope / parked

- **Span-head + lower-fertility vocab (#727):** future-enablement for CJK/Cyrillic, not this sprint.
  Coordinate-invisible today.
- **The `enforceWordConsistency` decode-fix:** already shipped default-OFF; not revived here.
- **A transformer reranker:** gated behind the cheap LightGBM falsifier showing ranking-gap signal.

## Exit criteria

1. The US Three-Gap Matrix is computed (coverage / recall / ranking, at k = 5/10/20) and the decision
   rule fires a route.
2. The matrix is re-weighted EU-strategic + the parse-blocker proxy is run on FR/DE/ES/IT samples.
3. The reranker-vs-coverage-vs-multi-locale route is chosen — with the strategic fork resolved by the
   operator if the two weightings diverge.
4. DeepSeek's numeric bet is confirmed or refuted against the actual matrix (logged, not hand-waved).
