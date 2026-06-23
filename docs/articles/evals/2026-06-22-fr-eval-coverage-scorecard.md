# FR / non-US eval-coverage scorecard (#229 Phase A) — 2026-06-22

_What this is: the consult's Phase A, grounded. Before the next FR/CJK capability push can be **aimed**, we need honest held-out floors on the fine + non-US components — and an honest read of which strata our current golden can't yet measure. This grades the **production** model (v4.11.0 = v1.8.0, `defaultVersion` live) on the existing per-locale golden (`data/eval/golden/v0.1.2/{us,fr}.jsonl`, anchor + gazetteer fed, the `per-locale-f1` ship-config harness), flags each floor's reliability by support size, and maps exactly what data each thin stratum needs. It is measurement + a data plan, not a model change._

## The scorecard — production model (v1.8.0), per-locale per-tag

Reliability: **✓ reliable** (n ≥ 100) · **~ thin** (10 ≤ n < 100) · **✗ unmeasured** (n < 10). Coordinate-relevance = does the tag reach the assembled coordinate we ship (the only metric that promotes).

### FR (`fr.jsonl`)

| tag                               |         n | precision |   recall |       F1 | reliability                                          | coord-relevant |
| --------------------------------- | --------: | --------: | -------: | -------: | ---------------------------------------------------- | -------------- |
| postcode                          |      1262 |      99.5 |     99.8 | **99.7** | ✓                                                    | ✓              |
| house_number                      |       665 |      99.7 |     99.5 | **99.6** | ✓                                                    | ✓ (rooftop)    |
| street                            |       665 |      90.1 |     90.1 | **90.1** | ✓                                                    | ✓              |
| locality                          |      1537 |      86.3 |     86.5 | **86.4** | ✓                                                    | ✓              |
| region                            |       219 |      57.6 | **34.7** | **43.3** | ⚠ non-representative (95 multi-script + order-perms) | ✓ (admin)      |
| country                           |        93 |  **43.0** |     92.5 |     58.7 | ~ thin                                               | ✗ invisible    |
| po_box                            |         6 |      83.3 |     83.3 |     83.3 | ✗                                                    | ~              |
| dependent_locality                |        12 |         0 |        0 |        0 | ✗                                                    | ~              |
| venue                             |     **1** |         — |        — |    **0** | ✗ unmeasured                                         | ✓ (POI)        |
| unit                              |     **0** |         — |        — |        — | ✗ absent                                             | ~              |
| cedex / street_prefix(\_particle) | 1 / 7 / 6 |         — |        — |        0 | ✗                                                    | ~              |

### US (`us.jsonl`, for contrast)

| tag                     |           n |          F1 | note                                                                               |
| ----------------------- | ----------: | ----------: | ---------------------------------------------------------------------------------- |
| postcode / house_number | 1695 / 1031 | 98.6 / 98.4 | ✓                                                                                  |
| region                  |        2956 |        89.6 | ✓ reliable (FR's 219 is non-representative, so US is the only honest region floor) |
| venue                   |        1075 |    **90.8** | the model **can** do venue — FR's 0% is a coverage gap, not a model limit          |
| locality                |        1792 |        75.0 | ✓                                                                                  |
| street                  |        2216 |        81.0 | ✓                                                                                  |
| country                 |         150 |        68.2 | precision-bound here too (p=52.3) — country over-emission is global                |
| unit                    |           2 |         9.1 | unit is under-measured **everywhere**, not just FR                                 |

## Findings

1. **The reliable FR floors are good** — postcode 99.7, house_number 99.6, street 90.1, locality 86.4. The shipped FR address resolves; this is the v1.8.0 win holding.
2. **The `region` floor (43.3) is an ADVERSARIAL-STRESS number, not a representative real-FR measurement — corrected on inspection.** A dump of the 219 région rows shows they are **entirely synthetic stress permutations**: 95/219 are multi-script (Cyrillic `Шом`, Han `富尔内勒`, romanized `Runik yozuv` localities — the #555 non-Latin class), and the rest are order-permutations of a handful of rural communes (Creuse / Lozère / Thauron / La Ronze). The model emits région **99.6%** on the in-distribution `Locality, Département` admin-split format. So the 34.7% recall is a **multi-script / OOD-robustness** signal, not a representative real-FR région floor — and there is **no representative real-FR région eval on disk** (the admin-split golden is in-distribution; using it would game the floor to ~96%). The honest statement: real-FR région performance is **unmeasured**; the only signals we have are the gamed in-distribution 99.6% and the adversarial-stress 34.7%. (`country`, by contrast, is genuinely coordinate-invisible — see below.)
3. **`country` is precision-bound and coordinate-invisible.** FR country precision 43.0 (recall 92.5) — the model _over-emits_ country, hallucinating it on rows with no country token. This is global (US precision 52.3 too). It's the exact tag tonight's shelved v1.8.1 tried to fix by adding France examples (recall↑/precision↓ — wrong direction, falsified). Fixing it is a **label-only** win.
4. **`venue` and `unit` are unmeasured for FR** (n = 1 and 0). The "venue 0%" that's haunted the FR narrative since #330 is measured on a **single row** — it is not a reliable signal, it's an absence of test data. US proves the model can emit venue (90.8); the FR gap is that the model was never trained on FR venue **and** we have no FR venue/unit truth to grade it.

## Spot-check — the shipped model on REAL Spanish addresses (novel, #148)

Since OA-ES is on disk (`oa-cache/es__countrywide.zip`), a 120-row held-out set was built from real Spanish cadastral addresses (52 provinces, named-street-types only, rendered in three natural orders) and graded on the production model — a locale the model has **never been trained on** (it's en-us + fr). The honest result:

| tag               |   n |       F1 | read                                                                        |
| ----------------- | --: | -------: | --------------------------------------------------------------------------- |
| postcode          | 120 | **86.3** | numeric — the one thing that transfers                                      |
| locality          | 119 | **49.6** | half-right                                                                  |
| house_number      | 120 | **38.4** | trailing-number position (ES `Calle X 1`) trips the US/FR lead-number prior |
| street            | 120 | **24.9** | genuinely weak                                                              |
| region/unit/venue |   — |        0 | not in OA-ES                                                                |

Macro-F1 **28.5%**. **Verify-before-verdict applied:** the low street score is NOT a `Calle`-prefix labeling artifact — re-grading with a bare-name gold (street_prefix split out) drops street to **2.0%**, i.e. the model does not emit `Calle` as a prefix; the weakness is real OOD. This **quantifies the cost of the held #148 multi-locale retrain** on a real, third locale (not FR): a Latin-script EU locale the model wasn't trained on resolves its postcode but mangles street/house_number/locality. The OA-ES builder is a spot-check here; a committed `build-oa-golden` (ES + IT, both on disk) is the follow-up that would make this a standing non-US floor.

## The honest non-US measurement — an 8-locale ASSEMBLED-COORDINATE panel (the headline)

OA carries truth coordinates, so held-out sets for eight locales (150 rows each, all real, natural orders, `build-oa-coord-golden.py`; provenance + filters in the builder docstring) can be graded on the **metric we ship** — parse → resolve → great-circle error — separating the **resolve rate** (did it produce a resolvable parse?) from the **resolved-only coordinate** (how accurate when it does). This is the honest dial; label-F1 is confounded (the ES street 24.9% is a `Calle`-boundary artifact, confirmed by a bare-name A/B that drops it to 2.0%).

| locale | resolve rate | n resolved | p50 (resolved) | p90 (resolved) | tier                                      |
| ------ | -----------: | ---------: | -------------: | -------------: | ----------------------------------------- |
| FR     |      **80%** |  120 / 150 |         1.3 km |         191 km | top (trained)                             |
| IT     |      **79%** |  119 / 150 |         2.1 km |         272 km | top (in #149 EU shards)                   |
| LU     |      **57%** |   86 / 150 |         0.3 km |           2 km | mid (small dense country — rooftop-tight) |
| PL     |      **53%** |   79 / 150 |         5.8 km |         405 km | mid                                       |
| PT     |      **52%** |   78 / 150 |         1.2 km |         216 km | mid                                       |
| AT     |      **50%** |   75 / 150 |         5.2 km |         171 km | mid                                       |
| CZ     |      **43%** |   64 / 150 |          44 km |         278 km | low-mid (loose resolve too)               |
| AU     |      **28%** |    20 / 72 |         234 km |        2366 km | low (collisions)                          |

> **Read the right column as a ceiling, not an average.** The resolved-only coordinate is over only the addresses the model _chose_ to resolve, and the ones it drops are disproportionately harder — so the resolved coord flatters the model, most of all where the resolve rate is low (AU's 234 km is on **20 points**, CZ's 44 km on 64 — treat both as noisy). The unbiased signal is the resolve **rate**, which is over the full sample. 150/locale also carries a ±~8% band — rank the tiers, don't over-read small mid-tier deltas.

_8 resolvable locales — the panel is ~complete for postcode-bearing OA. Tiers: top FR/IT ~80%, mid LU/PL/PT/AT ~50–57%, low-mid CZ 43%, low AU 28%. **Most resolved coords are city-to-rooftop tight (0.3–6 km)** — the "where it resolves, it's accurate" rule — **except CZ (44 km) and AU (234 km), which resolve loosely too** (wrong same-name place; the dual-axis-worst locales). DE/BE/DK/FI OA lack a POSTCODE column → not cleanly coordinate-gradeable (the resolve path needs the postcode anchor); ES is cadastral → label-only. So the postcode-bearing set is essentially mapped; broadening further needs postcode-complete sources._

**This is the night's load-bearing finding — two axes, and it reframes #148.**

- **Precision is good where it resolves (EU).** A resolved EU address lands city-accurate (p50 1–6 km) — so the parse + resolution quality, _conditional on resolving_, is fine. This is why label-F1 misleads: the model gets `locality` + `postcode` right enough to geocode the right city even when it mis-tags street boundaries, and label-F1 charges those boundary errors while the coordinate doesn't. (The #566 / v1.7.0 "grade the coordinate" lesson, confirmed on non-US with hard coordinate truth.)
- **The real gap is resolve RATE (recall), and it tracks TRAINING REPRESENTATION.** The split is clean: **FR 80% / IT 79%** (the trained / well-represented locales — FR is v1.8.0's home turf, IT rode the #149 EU shards) resolve at ~80% with city-tight coords, while **PT/PL ~52%** (present but under-represented) and **AU 28%** (barely represented, + cross-state name collisions like Windsor) fall off. The model fails to produce a resolvable parse for ~half of mid-tier EU addresses and ~72% of AU. So the gap is _coverage of the training distribution_, exactly the #148 lever.

So the #148 multi-locale retrain's value is **lifting parse recall on the non-IT locales** (+ AU collision handling), **not** fixing coordinate precision — a more precise, cheaper-to-justify target than "the model can't do non-US," now quantified across four real locales.

**Root-cause check — parse gap, not coverage gap (so the lever is the model, not the gazetteer).** PT resolves 52% but its label `locality`-recall is **39%** (equally low), while _where_ it resolves the coordinate is tight (1.2 km). If the unresolved half were a coverage miss (locality extracted, gazetteer can't place it), label-recall would be high and resolve-rate low — the opposite. Instead both are low: the model **fails to extract a resolvable locality** for ~half of non-IT EU addresses. So #148 (retrain to lift parse recall) is the justified lever; gazetteer coverage is _not_ the bottleneck (the EU candidate is comprehensive — see the #734 retirement). ⚠ _Earlier-in-the-night caveat (verify-before-verdict): the IT-only read (p50 3 km → "median non-US geocodes well") was the BEST case; the panel corrected it — IT is the exception, not the rule._

Artifacts: `scripts/eval/build-oa-coord-golden.py`, `data/eval/external/oa-{it,pt,au,pl}-coord-150.jsonl`, `scripts/eval/fr-admin-split-gate.ts --default-country <CC>` (+ resolved-only metric).

## Failure taxonomy (#375) — what kind of gap each is

| stratum                                                   | gap class                                                                                                                                            | fix lever                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| FR région (43.3 = adversarial-stress; real-FR unmeasured) | **eval-non-representativeness** — the 219 rows are synthetic multi-script + order permutations; real-FR région is unmeasured (in-dist = 99.6% gamed) | a representative real-FR région held-out set (natural orders, Latin) — the prerequisite to even state the gap |
| FR country (precision 43%)                                | **model** — over-emission; but coordinate-invisible                                                                                                  | precision lever (suppress country-without-token) — low priority, label-only                                   |
| FR venue (n=1)                                            | **eval-thinness + coverage** — no FR venue truth, no FR venue training                                                                               | fetch FR POIs → held-out venue set + a venue training shard                                                   |
| FR unit (n=0)                                             | **eval-thinness + coverage** (global)                                                                                                                | fetch unit-bearing addresses (FR + thicken US)                                                                |

## Data-acquisition plan (the real Phase-A unblock)

⚠ **Correction (verify-before-verdict, my own miss): FR address data is NOT blocked.** `fr/countrywide.csv` (BAN) is in `openaddresses/europe.zip` all along — I checked only the empty `/tmp/oa-cache` and wrongly called it gone. The FR **coordinate** eval is now built from it (`oa-fr-coord-150.jsonl`, FR 80% / p50 1.3 km — top tier). The genuinely-blocked FR strata are narrower: **venue/unit** (no POI/unit source — OA carries neither) and a **real-FR `region`** stratum (the OA-FR `REGION` column is empty, unlike OA-IT). For those, the next shift fetches, via the mailwoman CLI (never ad-hoc duckdb — the Overture OOM lesson):

- **FR venue** → Overture **places** theme for FR (POI name + address) or OSM FR POIs → render `Venue, NN Street, PPPPP City`, venue = POI name. Unblocks both the held-out venue set **and** the T2 venue training shard.
- **FR OOD région** → re-fetch OA FR (BAN) and render `département` in the varied real-world orders the model misses (NOT the in-distribution admin-split format, which would game the floor to ~96%).
- **FR/US unit** → a real unit-bearing source (`unit-real-designators.jsonl` exists for US as an _external_ eval; fold it into the golden + find an FR analogue).

## GPU decision — no training tonight ($20 unspent)

Both planned GPU-stretch levers fail their bar on inspection:

- **T1 (fr.country precision) — HELD: coordinate-invisible.** The gap is real but the resolver never reads the model's country tag (placer-sourced in eval + prod). Per "grade the assembled coordinate, never label-F1," a label-only fix doesn't justify GPU — the same logic that correctly shipped v1.8.0 _despite_ fr.country −3.5.
- **T2 (FR venue) — HELD: data-blocked.** Coordinate-relevant, but the training shard needs FR venue strings we don't have on disk. Blocked on the same fetch as the venue eval set.

No lever clears the coordinate bar with on-disk data, so the disciplined call is **no GPU**. The substantive build pivots to the on-disk, coordinate-relevant coverage win (#734 AT/SK bilingual depth) — keeping the week's zero-GPU, real-data, coordinate-graded throughline.
