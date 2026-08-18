# Open-truth three-arm benchmark — Mailwoman vs Pelias vs Photon (2026-08-18)

_The publishable slice of the August 2026 three-arm geocoder comparison: every row printed here has a
reference coordinate traceable to an open address register. Measurements: Pelias and Photon captured
2026-08-09 (UTC), Mailwoman captured 2026-08-12. Published 2026-08-18._

_Data: `docs/static/benchmarks/open-truth-panel.jsonl` (the 297 query rows with their reference
coordinates, sha256 `07d9b8ee…`) and `docs/static/benchmarks/open-truth-results.jsonl` (the per-row
distances for all three arms, sha256 `26630dc7…`). Scorer:
`docs/static/benchmarks/open-truth-three-arm.mjs` — `node open-truth-three-arm.mjs` recomputes every
table below from the committed results, deterministically and offline._

## Protocol

Pre-registered before the first import as §4 of
`docs/superpowers/plans/2026-08-06-local-pelias-benchmark-rig.md`, and locked in the scorer header:

- Top-1 result only, the exact same raw query string to every arm — no per-arm normalization.
- Haversine distance (R = 6371 km) from the top result to the row's reference coordinate.
- Thresholds 1 / 5 / 25 km. **No result = a miss at every threshold.** A low-confidence fallback
  counts as a result.
- Arms queried in a fixed per-row order, rows in panel order; the scorer is deterministic. The
  Pelias and Photon captures were each run twice with byte-identical A/B output (checksums in the
  receipts); the Mailwoman capture is a single run of the same harness.
- Results reported per `truth_type` stratum, never blended silently. Every row in this record is the
  `rooftop` stratum — the withheld strata are named below.

## What is published, and what is withheld

The full internal panel is 420 rows across seven lanes, 60 per lane, each row carrying a reference
coordinate assigned before any arm ran. Reference-coordinate provenance is per row, not per lane, and
it splits four ways:

| provenance of the reference coordinate                                    | rows | published?                 |
| ------------------------------------------------------------------------- | ---: | -------------------------- |
| open address registers, via the OpenAddresses collections (all `rooftop`) |  342 | 297 (the en-gb 45 are not) |
| licensed sources                                                          |   21 | no                         |
| the project's own gazetteer (circular — not independent truth)            |   25 | no                         |
| internally curated regression cases without register provenance           |   32 | no                         |

Rows whose reference coordinates derive from licensed sources are withheld. Rows whose reference
coordinate came from the project's own gazetteer are withheld because grading an engine against its
own data source is not an independent measurement (an independent re-source of those 25 city-only
coordinates on 2026-08-17 confirmed all of them within each row's pre-assigned tolerance, but the
scores below were produced against the original coordinates, so the rows stay out). The internally
curated cases are withheld because their coordinates do not trace to a register.

The **en-gb lane is withheld in full**: two of its rows carry licensed-source reference coordinates,
and the lane's reference set is under separate review. Its open-register remainder is not printed
here.

What remains is **297 rows across six lanes**, all `rooftop` truth, published in full — the per-lane
denominators below state exactly how many of each lane's 60 rows survived the provenance cut. The
internal 420-row aggregate is not restated here, because part of its reference set cannot be
published; this record's numbers are computed only over rows whose truth a third party can check.

## The three arms

| arm       | engine                                                                                                                                                                                               | index / data footprint                                                                                                                                                                                                                                             | captured         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Mailwoman | repo `main` as of 2026-08-12 (through #1635/#1636); model = the shipped npm model **v4.4.0-suffix-boundary-v2 step-60000 (int8)**, published as `@mailwoman/neural-weights-en-us@9.1.0` (2026-08-11) | candidate gazetteer `2026-08-12a` (the same artifact the public demo serves), plus rooftop layers: G-NAF AU (16,025,856 points), LINZ NZ, BAN FR, US open address points + TIGER interpolation, and OSM-derived address points (DE, NL)                            | 2026-08-12       |
| Pelias    | `pelias/docker` @ `3dfa07d5`, images pinned by digest (Elasticsearch 7.17.27; `pelias/api:master@sha256:cec95697…`)                                                                                  | scoped local build, 12 countries (US FR DE GB AU NZ AT CH CZ DK BE NL): OpenAddresses (311 source files, countrywide for FR/AU/NZ), per-country OSM extracts, Who's On First, polylines + interpolation; built 2026-08-07/08, source checksums in the rig manifest | 2026-08-09 (UTC) |
| Photon    | komoot/photon **1.3.0**                                                                                                                                                                              | the public pre-built **planet** index, vintage 2026-08-03 (OpenStreetMap)                                                                                                                                                                                          | 2026-08-09 (UTC) |

The footprints are deliberately different, and the comparison is behavioral, not
index-for-index: Photon answers from an OSM planet index; Pelias and Mailwoman answer from local
builds scoped to the panel countries. This helps Photon wherever OSM has the address and hurts it
wherever OSM does not; it is stated here rather than corrected for.

One arm-configuration caveat: Mailwoman's `eu-mixed` rows ran under the production default `en-US`
locale (no EU-mixed weights package exists), so that lane measures the unconstrained fallback path,
not a locale-tuned configuration.

## Results — per lane, all three arms

Reference coordinates are register rooftops, so the @1 km column is the demanding one. Denominators
are the open-truth rows retained from each 60-row lane. "no result" rows are misses at every
threshold and are included in every denominator.

### de-de — Germany (n = 49 of 60)

| arm       | @1 km         | @5 km         | @25 km         | no result |
| --------- | ------------- | ------------- | -------------- | --------- |
| Mailwoman | 44/49 (89.8%) | 45/49 (91.8%) | 49/49 (100.0%) | 0         |
| Pelias    | 45/49 (91.8%) | 45/49 (91.8%) | 49/49 (100.0%) | 0         |
| Photon    | 48/49 (98.0%) | 48/49 (98.0%) | 48/49 (98.0%)  | 1         |

Photon leads this lane at 1 km; Mailwoman trails both arms at 1 km.

### en-au — Australia (n = 56 of 60)

| arm       | @1 km         | @5 km          | @25 km         | no result |
| --------- | ------------- | -------------- | -------------- | --------- |
| Mailwoman | 54/56 (96.4%) | 56/56 (100.0%) | 56/56 (100.0%) | 0         |
| Pelias    | 54/56 (96.4%) | 55/56 (98.2%)  | 55/56 (98.2%)  | 0         |
| Photon    | 47/56 (83.9%) | 53/56 (94.6%)  | 54/56 (96.4%)  | 2         |

### en-nz — New Zealand (n = 57 of 60)

| arm       | @1 km          | @5 km          | @25 km         | no result |
| --------- | -------------- | -------------- | -------------- | --------- |
| Mailwoman | 57/57 (100.0%) | 57/57 (100.0%) | 57/57 (100.0%) | 0         |
| Pelias    | 43/57 (75.4%)  | 43/57 (75.4%)  | 43/57 (75.4%)  | 0         |
| Photon    | 57/57 (100.0%) | 57/57 (100.0%) | 57/57 (100.0%) | 0         |

Mailwoman and Photon both resolve every row; the 14 Pelias misses all land beyond 25 km
(wrong-place answers, not near-misses).

### en-us — United States (n = 45 of 60)

| arm       | @1 km         | @5 km         | @25 km         | no result |
| --------- | ------------- | ------------- | -------------- | --------- |
| Mailwoman | 41/45 (91.1%) | 44/45 (97.8%) | 45/45 (100.0%) | 0         |
| Pelias    | 44/45 (97.8%) | 44/45 (97.8%) | 44/45 (97.8%)  | 0         |
| Photon    | 34/45 (75.6%) | 38/45 (84.4%) | 38/45 (84.4%)  | 7         |

Pelias leads at 1 km; Mailwoman trails it by 3 rows there.

### eu-mixed — AT / CH / CZ / DK / BE / NL (n = 45 of 60)

| arm       | @1 km          | @5 km          | @25 km         | no result |
| --------- | -------------- | -------------- | -------------- | --------- |
| Mailwoman | 26/45 (57.8%)  | 40/45 (88.9%)  | 43/45 (95.6%)  | 1         |
| Pelias    | 45/45 (100.0%) | 45/45 (100.0%) | 45/45 (100.0%) | 0         |
| Photon    | 44/45 (97.8%)  | 44/45 (97.8%)  | 44/45 (97.8%)  | 1         |

Mailwoman's weakest published lane by a wide margin: Pelias resolves all 45 rows to the rooftop,
Mailwoman gets 26 of 45 inside 1 km. (This is also the lane running Mailwoman's `en-US` fallback —
see the caveat above — but the loss prints regardless of the explanation.)

### fr-fr — France (n = 45 of 60)

| arm       | @1 km         | @5 km         | @25 km         | no result |
| --------- | ------------- | ------------- | -------------- | --------- |
| Mailwoman | 36/45 (80.0%) | 44/45 (97.8%) | 45/45 (100.0%) | 0         |
| Pelias    | 42/45 (93.3%) | 43/45 (95.6%) | 45/45 (100.0%) | 0         |
| Photon    | 25/45 (55.6%) | 33/45 (73.3%) | 35/45 (77.8%)  | 9         |

Pelias leads at 1 km by 6 rows; Mailwoman leads at 5 km by 1 row.

### Pooled over all 297 published rows

| arm       | @1 km           | @5 km           | @25 km          | no result |
| --------- | --------------- | --------------- | --------------- | --------- |
| Mailwoman | 258/297 (86.9%) | 286/297 (96.3%) | 295/297 (99.3%) | 1         |
| Pelias    | 273/297 (91.9%) | 275/297 (92.6%) | 281/297 (94.6%) | 0         |
| Photon    | 255/297 (85.9%) | 273/297 (91.9%) | 276/297 (92.9%) | 20        |

Pooled, **Pelias leads at 1 km** (91.9% vs Mailwoman's 86.9%); **Mailwoman leads at 5 km and
25 km**. Photon's pooled numbers carry 20 no-result rows.

### Uncertainty (paired bootstrap, Mailwoman − Pelias)

Computed by the committed scorer (mulberry32, seed 20260807, 1000 resamples, percentile 2.5/97.5).
The §4 pre-registration set a ±5 pp equivalence bound at 25 km on this difference.

| group  |   n | threshold | diff (mw − pelias) | 95% CI       |
| ------ | --: | --------- | -----------------: | ------------ |
| pooled | 297 | 1 km      |            −5.1 pp | [−9.8, −0.7] |
| pooled | 297 | 5 km      |            +3.7 pp | [+0.7, +6.7] |
| pooled | 297 | 25 km     |            +4.7 pp | [+2.0, +7.4] |

At 1 km the CI excludes zero in Pelias's favor. At 5 km and 25 km it excludes zero in Mailwoman's
favor. The pre-registered ±5 pp equivalence claim at 25 km is **not** met — the CI extends past
+5 pp — so the 25 km result reads as a directional difference in Mailwoman's favor, not as
equivalence. Per-lane CIs are wide at these denominators (run the scorer for the full table); the
only per-lane differences whose CIs exclude zero are en-nz (Mailwoman +24.6 pp, all thresholds) and
eu-mixed (Pelias, 1 km and 5 km).

## Reading the table — shared upstreams

The reference coordinates and two of the arms' indexes share upstream data, and the @1 km column
should be read with that in view:

- **OpenAddresses is a Pelias-indexed source.** Pelias's rooftop hits on these rows are partly
  recall of its own index.
- **Mailwoman's rooftop layers share upstreams with the truth on four lanes**: G-NAF (en-au), LINZ
  (en-nz), BAN (fr-fr), and the US open address-point files (en-us). Its rooftop hits there are
  likewise partly recall of shared upstream data. Its de-de and eu-mixed answers draw on
  OSM-derived address points and the admin gazetteer, not on the registers the truth came from —
  which is visible in the numbers.
- **Photon's index is OpenStreetMap only** — no OpenAddresses, no national-register feed. Its @1 km
  column is closest to a measure of independent coverage, and its no-result and beyond-25 km rows
  are OSM address-coverage gaps.

So the summary sentence is narrow: on register-rooftop queries in these six lanes, all three
engines are in the same band at 1 km pooled (85.9–91.9%), Pelias ahead; Mailwoman degrades least beyond
1 km (96.3% at 5 km, 99.3% at 25 km, one no-result in 297 rows), which is its designed behavior —
resolve to the right place at some tier rather than return nothing.

## Truth sources and attribution

Every published reference coordinate comes from an open address register via the
[OpenAddresses](https://openaddresses.io/) collections. Per-row provenance is in the committed
panel's `source` field; per-source licenses are in the OpenAddresses source manifests.

| lane     | register / upstream                                                                                      | license                             |
| -------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| de-de    | German state and municipal open-data address registers (OpenAddresses `de` collection)                   | per-source (open); see OA manifests |
| en-au    | G-NAF, © Geoscape Australia (OpenAddresses `au/countrywide`)                                             | CC BY 4.0, attribution required     |
| en-nz    | LINZ — Toitū Te Whenua Land Information New Zealand (OpenAddresses `nz/countrywide`)                     | CC BY 4.0                           |
| en-us    | US county and state address-point files (OpenAddresses `us` collection)                                  | per-source (open); see OA manifests |
| eu-mixed | national open address registers for AT / CH / CZ / DK / BE / NL, incl. ČÚZK RÚIAN for CZ (OpenAddresses) | per-source (open); see OA manifests |
| fr-fr    | BAN — Base Adresse Nationale (DINUM / IGN; OpenAddresses `fr/countrywide`)                               | Licence Ouverte 2.0                 |

Photon's answers derive from OpenStreetMap (© OpenStreetMap contributors, ODbL); Pelias's from the
sources listed in its footprint above.

## Re-running this

The claim decomposes into two checks, one offline and one live:

1. **Check the tables against the committed measurements** (no network, deterministic):

   ```
   node docs/static/benchmarks/open-truth-three-arm.mjs
   ```

   Every table above is regenerated from `docs/static/benchmarks/open-truth-results.jsonl`. (The
   published site serves the whole bundle under `/benchmarks/`.)

2. **Re-measure the arms** over the committed panel:

   ```
   node docs/static/benchmarks/open-truth-three-arm.mjs --run \
     --pelias-url http://localhost:4000 \
     --photon-url http://localhost:2322 \
     --mailwoman-cli path/to/mailwoman/out/cli.js \
     --out results.jsonl
   node docs/static/benchmarks/open-truth-three-arm.mjs --results results.jsonl
   ```

   You supply the engines: a Pelias build (the original's source scope and checksums are in the rig
   manifest), a Photon planet index, and a compiled Mailwoman with its data pulled
   (`mailwoman data pull`). Index vintages will differ from the August 2026 captures, so expect
   row-level drift; the protocol and panel do not change.

Lab-internal receipts (not published, referenced for lineage): the full 420-row panel
(`$MAILWOMAN_DATA_ROOT/pelias-rig/panel/panel-v2.jsonl`, sha256 `e2db3180…`), the Mailwoman capture
(`…/pelias-rig/logs/full-panel-mw-arm-2026-08-12.json`), the Pelias capture
(`…/logs/benchmark-results-panel-v2-a.jsonl`, A/B sha256 `ad43a05b…`), and the Photon capture
(`…/logs/photon-results-panel-v2-a.jsonl`, A/B sha256 `cdfdae98…`). The committed panel rows are
field-for-field identical to their panel-v2 originals.
