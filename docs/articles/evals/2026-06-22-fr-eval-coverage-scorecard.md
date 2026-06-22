# FR / non-US eval-coverage scorecard (#229 Phase A) — 2026-06-22

_What this is: the consult's Phase A, grounded. Before the next FR/CJK capability push can be **aimed**, we need honest held-out floors on the fine + non-US components — and an honest read of which strata our current golden can't yet measure. This grades the **production** model (v4.11.0 = v1.8.0, `defaultVersion` live) on the existing per-locale golden (`data/eval/golden/v0.1.2/{us,fr}.jsonl`, anchor + gazetteer fed, the `per-locale-f1` ship-config harness), flags each floor's reliability by support size, and maps exactly what data each thin stratum needs. It is measurement + a data plan, not a model change._

## The scorecard — production model (v1.8.0), per-locale per-tag

Reliability: **✓ reliable** (n ≥ 100) · **~ thin** (10 ≤ n < 100) · **✗ unmeasured** (n < 10). Coordinate-relevance = does the tag reach the assembled coordinate we ship (the only metric that promotes).

### FR (`fr.jsonl`)

| tag | n | precision | recall | F1 | reliability | coord-relevant |
| --- | --: | --: | --: | --: | --- | --- |
| postcode | 1262 | 99.5 | 99.8 | **99.7** | ✓ | ✓ |
| house_number | 665 | 99.7 | 99.5 | **99.6** | ✓ | ✓ (rooftop) |
| street | 665 | 90.1 | 90.1 | **90.1** | ✓ | ✓ |
| locality | 1537 | 86.3 | 86.5 | **86.4** | ✓ | ✓ |
| region | 219 | 57.6 | **34.7** | **43.3** | ⚠ non-representative (95 multi-script + order-perms) | ✓ (admin) |
| country | 93 | **43.0** | 92.5 | 58.7 | ~ thin | ✗ invisible |
| po_box | 6 | 83.3 | 83.3 | 83.3 | ✗ | ~ |
| dependent_locality | 12 | 0 | 0 | 0 | ✗ | ~ |
| venue | **1** | — | — | **0** | ✗ unmeasured | ✓ (POI) |
| unit | **0** | — | — | — | ✗ absent | ~ |
| cedex / street_prefix(_particle) | 1 / 7 / 6 | — | — | 0 | ✗ | ~ |

### US (`us.jsonl`, for contrast)

| tag | n | F1 | note |
| --- | --: | --: | --- |
| postcode / house_number | 1695 / 1031 | 98.6 / 98.4 | ✓ |
| region | 2956 | 89.6 | ✓ reliable (FR's 219 is non-representative, so US is the only honest region floor) |
| venue | 1075 | **90.8** | the model **can** do venue — FR's 0% is a coverage gap, not a model limit |
| locality | 1792 | 75.0 | ✓ |
| street | 2216 | 81.0 | ✓ |
| country | 150 | 68.2 | precision-bound here too (p=52.3) — country over-emission is global |
| unit | 2 | 9.1 | unit is under-measured **everywhere**, not just FR |

## Findings

1. **The reliable FR floors are good** — postcode 99.7, house_number 99.6, street 90.1, locality 86.4. The shipped FR address resolves; this is the v1.8.0 win holding.
2. **The `region` floor (43.3) is an ADVERSARIAL-STRESS number, not a representative real-FR measurement — corrected on inspection.** A dump of the 219 région rows shows they are **entirely synthetic stress permutations**: 95/219 are multi-script (Cyrillic `Шом`, Han `富尔内勒`, romanized `Runik yozuv` localities — the #555 non-Latin class), and the rest are order-permutations of a handful of rural communes (Creuse / Lozère / Thauron / La Ronze). The model emits région **99.6%** on the in-distribution `Locality, Département` admin-split format. So the 34.7% recall is a **multi-script / OOD-robustness** signal, not a representative real-FR région floor — and there is **no representative real-FR région eval on disk** (the admin-split golden is in-distribution; using it would game the floor to ~96%). The honest statement: real-FR région performance is **unmeasured**; the only signals we have are the gamed in-distribution 99.6% and the adversarial-stress 34.7%. (`country`, by contrast, is genuinely coordinate-invisible — see below.)
3. **`country` is precision-bound and coordinate-invisible.** FR country precision 43.0 (recall 92.5) — the model *over-emits* country, hallucinating it on rows with no country token. This is global (US precision 52.3 too). It's the exact tag tonight's shelved v1.8.1 tried to fix by adding France examples (recall↑/precision↓ — wrong direction, falsified). Fixing it is a **label-only** win.
4. **`venue` and `unit` are unmeasured for FR** (n = 1 and 0). The "venue 0%" that's haunted the FR narrative since #330 is measured on a **single row** — it is not a reliable signal, it's an absence of test data. US proves the model can emit venue (90.8); the FR gap is that the model was never trained on FR venue **and** we have no FR venue/unit truth to grade it.

## Spot-check — the shipped model on REAL Spanish addresses (novel, #148)

Since OA-ES is on disk (`oa-cache/es__countrywide.zip`), a 120-row held-out set was built from real Spanish cadastral addresses (52 provinces, named-street-types only, rendered in three natural orders) and graded on the production model — a locale the model has **never been trained on** (it's en-us + fr). The honest result:

| tag | n | F1 | read |
| --- | --: | --: | --- |
| postcode | 120 | **86.3** | numeric — the one thing that transfers |
| locality | 119 | **49.6** | half-right |
| house_number | 120 | **38.4** | trailing-number position (ES `Calle X 1`) trips the US/FR lead-number prior |
| street | 120 | **24.9** | genuinely weak |
| region/unit/venue | — | 0 | not in OA-ES |

Macro-F1 **28.5%**. **Verify-before-verdict applied:** the low street score is NOT a `Calle`-prefix labeling artifact — re-grading with a bare-name gold (street_prefix split out) drops street to **2.0%**, i.e. the model does not emit `Calle` as a prefix; the weakness is real OOD. This **quantifies the cost of the held #148 multi-locale retrain** on a real, third locale (not FR): a Latin-script EU locale the model wasn't trained on resolves its postcode but mangles street/house_number/locality. The OA-ES builder is a spot-check here; a committed `build-oa-golden` (ES + IT, both on disk) is the follow-up that would make this a standing non-US floor.

## Failure taxonomy (#375) — what kind of gap each is

| stratum | gap class | fix lever |
| --- | --- | --- |
| FR région (43.3 = adversarial-stress; real-FR unmeasured) | **eval-non-representativeness** — the 219 rows are synthetic multi-script + order permutations; real-FR région is unmeasured (in-dist = 99.6% gamed) | a representative real-FR région held-out set (natural orders, Latin) — the prerequisite to even state the gap |
| FR country (precision 43%) | **model** — over-emission; but coordinate-invisible | precision lever (suppress country-without-token) — low priority, label-only |
| FR venue (n=1) | **eval-thinness + coverage** — no FR venue truth, no FR venue training | fetch FR POIs → held-out venue set + a venue training shard |
| FR unit (n=0) | **eval-thinness + coverage** (global) | fetch unit-bearing addresses (FR + thicken US) |

## Data-acquisition plan (the real Phase-A unblock)

The honest bottleneck: **building new FR fine-component held-out sets is data-blocked on disk.** The OA FR cache (`/tmp/oa-cache/fr__countrywide.zip`) is gone, the Overture **places** (POI) theme isn't materialized locally (only addresses + divisions + postcodes), and there's no FR unit source. To close the thin strata, the next shift fetches, via the mailwoman CLI (never ad-hoc duckdb — the Overture OOM lesson):

- **FR venue** → Overture **places** theme for FR (POI name + address) or OSM FR POIs → render `Venue, NN Street, PPPPP City`, venue = POI name. Unblocks both the held-out venue set **and** the T2 venue training shard.
- **FR OOD région** → re-fetch OA FR (BAN) and render `département` in the varied real-world orders the model misses (NOT the in-distribution admin-split format, which would game the floor to ~96%).
- **FR/US unit** → a real unit-bearing source (`unit-real-designators.jsonl` exists for US as an *external* eval; fold it into the golden + find an FR analogue).

## GPU decision — no training tonight ($20 unspent)

Both planned GPU-stretch levers fail their bar on inspection:

- **T1 (fr.country precision) — HELD: coordinate-invisible.** The gap is real but the resolver never reads the model's country tag (placer-sourced in eval + prod). Per "grade the assembled coordinate, never label-F1," a label-only fix doesn't justify GPU — the same logic that correctly shipped v1.8.0 *despite* fr.country −3.5.
- **T2 (FR venue) — HELD: data-blocked.** Coordinate-relevant, but the training shard needs FR venue strings we don't have on disk. Blocked on the same fetch as the venue eval set.

No lever clears the coordinate bar with on-disk data, so the disciplined call is **no GPU**. The substantive build pivots to the on-disk, coordinate-relevant coverage win (#734 AT/SK bilingual depth) — keeping the week's zero-GPU, real-data, coordinate-graded throughline.
