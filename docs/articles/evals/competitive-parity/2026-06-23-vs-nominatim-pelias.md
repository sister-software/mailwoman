# Competitive benchmark — mailwoman vs Nominatim vs Pelias (2026-06-23)

_The honest head-to-head, run for trade-show readiness. Harness: `scripts/eval/competitive-benchmark.ts`._
_Reproduce: `node scripts/eval/competitive-benchmark.ts --n 150 --locales it,pt,pl,at,cz,fr,au` (Pelias via geocode.earth; Nominatim via the public API at ~1 req/s)._

## Method (and why it's built this way)

Three systems, identical real held-out OpenAddresses rows (truth lat/lon), 150/locale. The systems return structurally different things — mailwoman resolves to a gazetteer **centroid**; Nominatim returns the matched **OSM object** (rooftop when it matches, nothing when it doesn't); Pelias is ES over OSM+OA+WOF — so a raw median-error race flatters whoever returns rooftops on the addresses they match and hides who returns nothing. So we score **resolve-rate @ a coarse km threshold** (within Xkm of truth; **"no result" = a miss**) as the honest denominator, plus conditional accuracy. Coarse thresholds (5/25 km = "right locality area") because mailwoman returns centroids — a km-to-rooftop metric would unfairly reward rooftop-when-it-matches.

## Headline — resolve-rate @ 25 km (clean inputs)

| locale  | mailwoman | nominatim |  pelias |
| ------- | --------: | --------: | ------: |
| IT      |   **92%** |       75% |     79% |
| PT      |       57% |       47% |     65% |
| PL      |       42% |   **96%** |     92% |
| AT      |       73% |   **97%** |     89% |
| CZ      |       33% |   **88%** |     68% |
| FR      |       66% |       59% | **94%** |
| AU      |       38% |   **97%** |     76% |
| **ALL** |   **59%** |   **79%** | **81%** |

| system    |   n | @1km | @5km | @25km | cond. p50 | no-result |
| --------- | --: | ---: | ---: | ----: | --------: | --------: |
| mailwoman | 972 |  26% |  52% |   59% |    1.8 km |       27% |
| nominatim | 972 |  74% |  78% |   79% |    0.0 km |       20% |
| pelias    | 972 |  66% |  77% |   81% |    0.0 km |        1% |

**On clean OpenAddresses, mailwoman trails both** (59 vs 79/81). The losing rows stay in the table.

## What's real and what's confounded (verify-before-verdict)

- **The loss is NOT a resolver-config handicap.** mailwoman is ~44% on the trailing locales across all three resolver configs — admin-only, admin + `postcode-locality-intl`, and the **demo's actual candidate gazetteer** (`candidate-global-20h`). The resolver isn't the cause.
- **Our internal "resolve-rate" metric OVERSTATES by ~15–22 pp.** Internal panel: PL resolve 62%, CZ 52%, AU 53%. Honest @25 km right-place: PL 42%, CZ 28–33%, AU 32–38%. The gap = resolves that land **>25 km** (region-level fallback / wrong same-name place) — counted as success by resolve-rate, as a miss by right-place. **We have been grading ourselves on a lenient metric.** (mailwoman's centroid is NOT the issue — p50 1.8 km, well inside 25 km; @25 km forgives it.)
- **The test set favors Pelias.** OpenAddresses is one of Pelias's INDEXED sources — its 81% / p50 0.0 km is partly recall-of-its-own-data, not generalization (home-field advantage). Nominatim (OSM) overlaps less. mailwoman trained on a disjoint held-out split.
- **The real mailwoman gap is coverage/recall:** ~27% no-result aggregate (worse on EU non-IT) vs Pelias ~1% / Nominatim ~20%. It fails to return a usable coordinate for a quarter of these addresses.

## Messy inputs — the slice that should favor a calibrated parser

_(filled from the `--messy` run: lowercase + dropped commas/dash-postcodes + abbreviations — the "typed in a hurry" case where a search index that leans on exact tokens + structure should degrade more than a learned parser.)_

Messy = lowercase + dropped commas/dash-postcodes + abbreviations (house numbers preserved). 40/locale.

| system    | clean @25km | messy @25km |                          Δ |
| --------- | ----------: | ----------: | -------------------------: |
| mailwoman |         59% |     **49%** |             −10 (graceful) |
| nominatim |         79% |     **81%** |      +2 (robust free-text) |
| pelias    |         81% |      ~~6%~~ | **INVALID — rate-limited** |

⚠ **Pelias's messy "6%" is a geocode.earth RATE-LIMIT artifact, not a finding** — verified by direct query: the API now returns **HTTP 429 on every call**, clean OR messy (the trial key's quota exhausted after ~1.2k calls; the messy run ran later than the clean run, so its Pelias column collapsed to 429→null→"no result"). The clean Pelias 81% (earlier, under quota) is likely valid; the messy Pelias number is **discarded**. _verify-before-verdict caught what would have been a false "Pelias collapses on messy" headline._

Real messy takeaway: **mailwoman degrades gracefully (−10pp); Nominatim's free-text search is robust (doesn't degrade)**. My perturbation didn't break Nominatim — OSM has the addresses and its tokenizer forgives lowercase/no-comma/no-postcode.

## US — the home turf (mailwoman vs Nominatim; Pelias rate-locked)

| locale | mailwoman | nominatim |
| ------ | --------: | --------: |
| **US** |   **99%** |       84% |

| system    |   n | @1km | @5km |   @25km | cond. p50 | no-result |
| --------- | --: | ---: | ---: | ------: | --------: | --------: |
| mailwoman | 150 |  18% |  67% | **99%** |    3.2 km |    **0%** |
| nominatim | 150 |  82% |  83% |     84% |    0.0 km |       16% |

**On US, mailwoman dominates: 99% vs 84%, and 0% no-result vs Nominatim's 16%.** Nominatim returns rooftops when it matches (p50 0.0 km) but misses 16% of US addresses — OSM's US coverage gaps (rural, new developments). mailwoman (TIGER + national situs + the candidate gazetteer) resolves _every_ address to the right locality. The US set is OpenAddresses, which Nominatim (OSM) does NOT index wholesale, so this is genuine coverage superiority, not data overlap.

## Honest verdict

The picture is nuanced — and good, once you stop grading on the lenient metric:

| market         | mailwoman | Nominatim |          Pelias |
| -------------- | --------: | --------: | --------------: |
| **US**         |   **99%** |       84% | _(rate-locked)_ |
| **EU (clean)** |       59% |       79% |            81%¹ |

1. ¹ EU is OpenAddresses, a Pelias-indexed source — its 81% is partly recall-of-its-own-data.

**Where we win:** US accuracy + coverage (the high-value market) — 99 vs 84, zero misses. Plus two capabilities the competitors structurally lack: **calibrated confidence** (knows when it's wrong) and **deployability** (30 MB, in-browser/offline, no Elasticsearch, no PostgreSQL+OSM-planet).

**Where we trail:** EU coordinate coverage. Nominatim/OSM and Pelias/OA simply have more EU address data than our gazetteer + model do today. This is a **coverage/recall gap** (no-result), not a precision gap (our resolved p50 is 1.8 km) — and it's the active roadmap: the v4.13.0 multi-locale ship, #370 (the rescore that recovers the wrong-place tail), and G-NAF/coverage ingestion all target exactly it.

**The methodology correction (most important internal takeaway):** our internal "resolve-rate" metric overstated EU by ~15–22 pp — it counts region-level / wrong-same-name resolves that land >25 km from truth. **Going forward, grade on right-place resolve-rate (@25 km / PIP-containment), not bare resolve-rate.** This is the #566 "grade the assembled coordinate" discipline, sharpened.

**Trade-show framing:** lead with US dominance + the calibrated-confidence demo + deployability; present EU as the fast-improving frontier (just shipped 16 locales). Do **not** claim "more accurate than Nominatim" globally — it's false on EU and true on US; claim it precisely.

_Caveats: Pelias rate-locked tonight (US Pelias + messy Pelias untested — re-run paced on fresh quota); EU set favors Pelias (OA overlap); n=150/locale._
