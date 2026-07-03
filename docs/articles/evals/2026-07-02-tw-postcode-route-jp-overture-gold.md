# TW postcode-route gate + JP Overture eval gold (#473, unblocks #294)

#473 asked for two CJK unblocks from Overture: the TW postcode→admin table #294 was parked on, and an
independent Overture-based eval gold for the shipped JP resolver. Both shipped — but not the way the
issue specced them, because the spec's data premise is false: **Overture release 2026-06-17.0 carries
ZERO postcodes for both TW (0/9,732,009) and JP (0/19,587,926)** (re-verified on the pinned release
after the 2026-05-20.0 probe in the issue comments; `fill-rates.md` now carries both rows). What
Overture does carry — 29.3M points with coordinates, admin attribution, and (divisions theme) real
district polygons — supplied the geometry both halves needed.

## TW — postcode-route resolution, gate PASS

**Keying source** (the postal authority, since Overture/GeoNames have no TW postcodes): Chunghwa
Post's 3-digit postal-code → district table with official district centers (data.gov.tw dataset
25489, OGDL v1; 371 rows, all county-prefixed). The 3-digit code is the admin-granularity key — the
"+3" tail is road-segment level, and the full 3+3 file has been account-gated at fpp.post.gov.tw
since 2025. Sub-district resolution is therefore out of reach for now (noted, not chased).

**Build** (`scripts/build-postcode-locality-tw.ts` → `postcode-locality-tw.db`, standard
`postcode_locality` schema — the `postcode_area_resolution` strategy consumes it unchanged):
official district center → containing Overture division polygon (368 district polygons, fetched
release-pinned by `scripts/eval/fetch-tw-division-polygons.ts`) → WOF row, tiered:

| tier                                                 | districts |
| ---------------------------------------------------- | --------: |
| district-tier (county/localadmin) inside polygon     |       248 |
| wikidata concordance (division.wikidata ↔ WOF wd:id) |        27 |
| Chinese/Overture-en name match inside polygon        |        66 |
| name + proximity (JP/KR-style fallback)              |         8 |
| containing-city (region) fallback                    |        22 |

The name-only JP/KR recipe topped out at 63% here: WOF's `county`-tier TW districts carry **no
Chinese names at all**, and the Kaohsiung/Taichung urban cores are `neighbourhood` or missing
entirely. The polygon bridge + Overture's en names ("Wanhua District" ↔ WOF "Wanhua") closed most of
the gap; the 22 districts WOF simply has no row for (三民區, 鹽埕區, the Taichung/Tainan directional
districts, offshore islands) map to their containing city — true containment, coarser granularity,
honestly recorded in the meta.

Two ladder-ordering findings, both measured (n=3,000, seed 42): name-confirmed district-tier must
outrank bare containment (Zhongshan's WOF point sits inside 中正區 — bare containment alone picks
the wrong namesake), and bare containment must outrank the wikidata bridge (wd-first dropped PIP
86.4→85.2% — WOF's TW wd concordances are themselves misattached, e.g. 890468273 "Zhongzheng Qu"
carries Keelung's Q712871 while its point sits in Taipei).

**Gate** (`scripts/eval/tw-postcode-route-eval.ts`, pre-registered from #288 Phase 1: postcode-route
PIP ≥~85%): held-out Overture address points, query = (district text + 3-digit postcode) against the
shipped `admin-global-priority.db` + the new table, graded by true point-in-polygon against the
Overture district polygons (WOF TW is point-only — every feature in the repo, `_pg` alts included,
is a Point, so WOF polygons cannot grade this).

| metric                         | n=3,000 seed 42 | n=1,500 seed 7 |
| ------------------------------ | --------------: | -------------: |
| resolve rate                   |          100.0% |         100.0% |
| **PIP-containment (district)** |       **86.4%** |      **86.3%** |
| + city-level containment       |           95.1% |          95.1% |
| coord p50 / p90 km             |    2.54 / 14.13 |   2.55 / 17.91 |

**PASS** (86.4% ≥ ~85%, stable across seeds). Failures concentrate exactly where WOF lacks district
rows (東區/北區/三民區/南區 …) — a WOF coverage gap, not a routing defect; the city-level containment
line is the honest ledger for those. Split note: the builder consumes no Overture address points
(inputs: postal table, WOF, division polygons), so every sampled point is held-out by construction;
the polygon layer is shared between the builder's bridge and the eval's truth.

`address_levels` agreement with polygon truth: 98.6% — the NLSC admin attribution and the divisions
geometry corroborate each other.

**Convention row:** TW (wof 85632403) added to `data/conventions/conventions.json` and compiled to
`conventions.db` — postcode-route coordinate-first, byte-identical to `WORLD_DEFAULT`, recorded
explicitly per the #289/#290 pattern. End-to-end verified through the rule engine with the
convention asset attached.

## JP — Overture eval gold, divergence investigated

**Gold** (`scripts/eval/build-jp-overture-gold.ts` → `data/eval/external/jp-overture-gold.jsonl`,
3,982 rows): reservoir-sampled Overture JP points (MLIT, 100% OA lineage), municipality gold +
coordinate from Overture, postcode joined from KEN*ALL by (prefecture, municipality) kanji — join
rate 99.5%. Since Overture JP has zero postcodes, the postcode→municipality \_pairing* still descends
from KEN_ALL (the only JP postcode source in existence here); the independent signals are the
address-weighted sampling frame, the municipality attribution, and the coordinate.

**Result** (`scripts/eval/jp-overture-gold-eval.ts`, same backend/query/normalization as
`jp-resolver-eval.ts`):

| measurement                          | name-agree |
| ------------------------------------ | ---------: |
| shipped number (2026-06-05, KEN_ALL) |      94.9% |
| KEN_ALL harness re-run TODAY         |      98.5% |
| **Overture gold (this work)**        |  **98.1%** |

The raw delta vs the shipped number is **+3.2pp — over the pre-registered 2pp band → investigated**:
re-running the unchanged KEN_ALL harness against today's shipped DBs gives **98.5%**, i.e. the
94.9% is a stale baseline (the admin DB has been rebuilt several times since 2026-06-05 — ancestry
backfill #832/#836, GeoNames aliases, coverage expansion). Against the contemporaneous baseline the
Overture gold diverges by **-0.4pp — within the band**. The two gold sources agree; the shipped JP
resolver's current operating point is ~98%, and `postcode-locality-jp.db`'s meta `match_rate` should
be re-stamped at its next rebuild. Coord p50/p90 vs the Overture point: 4.69 / 13.21 km
(municipality-centroid scale, as expected).

**Refresh-source note (for the convention-table provenance):** Overture is NOT viable as a JP
postcode refresh source (0% fill). KEN_ALL (rescued copy at `$MAILWOMAN_DATA_ROOT/KEN_ALL_ROME`)
remains the only keying source; Overture serves as the independent admin + coordinate gold.

## KR — explicitly out of scope

Unchanged from the issue: KR is absent from Overture's addresses theme; Juso remains the blocked
path. Noted, not chased.

## Artifacts

- `$MAILWOMAN_DATA_ROOT/wof/postcode-locality-tw.db` (new, 1,087 rows, provenance in meta)
- `$MAILWOMAN_DATA_ROOT/wof/dbs-per-country/admin-tw.db` (new, 18,597 places, built from
  whosonfirst-data-admin-tw via `build-unified-wof.ts`, beside the KR/JP siblings)
- `$MAILWOMAN_DATA_ROOT/wof/conventions.db` (new — first compiled convention asset, 1 row)
- `$MAILWOMAN_DATA_ROOT/overture/2026-06-17.0/addresses-{tw,jp}.parquet` + `divisions-tw-admin.jsonl`
  (release-pinned; fill-rates report regenerated with all 22 countries)
- `$MAILWOMAN_DATA_ROOT/tw-postal/district-centroids.xml` (Chunghwa Post source file)
- `data/eval/external/jp-overture-gold.jsonl` (checked in)

No canonical DB was replaced; every artifact is new beside the canonicals (night-shift policy).
