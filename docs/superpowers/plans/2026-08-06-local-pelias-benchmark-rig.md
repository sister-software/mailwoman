# The local Pelias benchmark rig — preregistration

Opened 2026-08-06 from the operator's directive, immediately downstream of the distance-to-done
review's finding that bar (b) — Pelias parity — is _unknown, last known behind_, on a 45-day-old
measurement of a four-majors-old model. The cure is a reproducible, pinned, LOCAL Pelias via Docker
Compose at the scope of the data we hold, plus a three-arm controlled comparison against
mailwoman 9.0.0 and same-day hosted geocode.earth.

Method notes: designed across a three-turn DeepSeek consult (session
`019fd8b2-63e4-71f6-931b-0f197276cdf8`). Per the consult calibration discipline, its structural
contributions are adopted; its three load-bearing factual claims are **preregistered as falsifiers
to run BEFORE any import** (§2) rather than trusted. Nothing below runs until the falsifiers are
graded.

## §1 — The build, scoped

**Panel countries:** US, FR, DE, GB, AU, NZ + AT/CH/CZ/DK/BE/NL (city-level EU panel). Forward
geocoding only.

**Services:** Elasticsearch (heap pinned 4 GB, `number_of_shards: 1`, `number_of_replicas: 0`) +
schema (one-shot), api, libpostal, placeholder (importers consult it for admin hierarchy — keeping
it is cheaper than proving they don't), interpolation (**required**: street-centroid fallback would
deflate the exact @1km metric under comparison). PIP omitted (no reverse). One custom project, one
ES index — N per-country projects buy complexity, not accuracy, at 420 queries.

**Pinning:** the `pelias/docker` release is pinned by commit AND image digests, never floating
tags. Data vintages pinned by SHA-256 manifest (§4).

**Data mapping (ours → Pelias):**

| Source          | Ours                                                                    | Pelias path                                                                                    |
| --------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| WOF admin       | official per-country `whosonfirst-data-admin-XX` SQLites (we hold them) | `data/whosonfirst` verbatim — our combined 5.3 GB product is NOT used                          |
| OpenAddresses   | standard-schema per-country CSVs (~20 countries held)                   | `data/openaddresses` verbatim; fetch `us` + `fr` (OA-fr ≈ BAN, which is upstream of it)        |
| TIGER           | 2024 shapefiles                                                         | `pelias/tiger` importer; 2020 unused                                                           |
| GNAF (AU)       | derived, non-official schema                                            | NOT used — OA au countrywide instead                                                           |
| Code-Point Open | postcode centroids                                                      | NOT used (no importer; postcode-level anyway)                                                  |
| OSM             | none on disk                                                            | Geofabrik country PBFs: DE, GB, AT, CH, CZ, DK, BE, NL, AU, NZ (+US pending the §2 falsifiers) |

**Per-country @1km attribution, assigned pre-hoc** (what the metric will ride on, and where the
scoped build genuinely diverges from hosted geocode.earth):

| Country  | @1km rides on                          | Scoped-build divergence risk                                                                         |
| -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| US       | TIGER ranges, then OA points, then OSM | if US OSM is skipped: venue rows suffer + NO interpolation (see §2a/b) — annotate `TIGER+OA, no OSM` |
| FR       | OA/BAN points                          | low — expect strong @1km                                                                             |
| GB       | OSM address nodes + interpolation      | **OSM required**; OA-gb sparse                                                                       |
| DE       | OSM address nodes + interpolation      | **OSM required**; OA-de patchy                                                                       |
| AU, NZ   | OA countrywide points                  | low; OSM optional                                                                                    |
| EU panel | OSM address nodes + interpolation      | **all six small PBFs required**                                                                      |

**Memory discipline (29 GB host, ~16 GB usable):** importers run as one-shot `docker compose run
--rm` jobs, strictly sequential, never concurrent with each other; api/interpolation down during
imports; ES `-Xms4g -Xmx4g`, Node services capped ≤1 GB each.

**Runbook (after §2 clears):** fetch PBFs → place OA CSVs (one per country, importer keys off
filenames) → place WOF sqlites → place TIGER 2024 → write `pelias.json` (imports block:
whosonfirst/openstreetmap/openaddresses/tiger/polylines datapaths + files lists) → ES up, wait
green → schema → whosonfirst → placeholder up → openaddresses → tiger → openstreetmap (the long
pole; per-country, sequential) → polylines (iff §2b passes) → interpolation build → libpostal +
interpolation + api up → per-country probes (§3) → freeze.

## §2 — Falsifiers: run these first, re-scope on failure

Three factual claims the plan leans on. Each gets a ≤30-minute probe, graded and recorded here
before any import runs:

- **(a) `pelias/interpolation` builds only from polylines (OSM centerlines), never TIGER.**
  Probe: shallow-clone `pelias/interpolation`, `grep -Ril tiger`, read the README data section.
  If TIGER can feed it, the US can keep interpolation without US OSM — a large scope win.
- **(b) `pelias/polylines` may accept only a planet file, not per-country.** Probe: shallow-clone,
  grep for the `files` config key + read the download script. If per-country works, US
  interpolation is affordable; if planet-only, the US row is annotated `no-interpolation` (or we
  hand-cut a US polylines file — an added build step, decided then).
- **(c) The runtime fits ~16 GB with sequential imports.** Probe: caps set, runtime stack up, one
  small importer (NZ OSM) under `docker stats`; check the compose file's DEFAULT ES heap first and
  fail fast if it exceeds 8 GB.

## §3 — Per-country acceptance probes (before any benchmark row)

1. A known OA/TIGER rooftop address → `layer: address`, under 50 m.
2. An interpolation-class address (no point record) → `address`/`street` with an interpolated
   point, under 1 km.
3. A city-only query → locality match, never empty.

A country failing its probes is marked `coverage-limited` and stays in the report with that label —
**never silently re-run or dropped** (preregistered stop rule).

## §4 — The three-arm protocol

**Arms:** mailwoman 9.0.0 (local, production defaults) · scoped local Pelias (this build) · hosted
geocode.earth (same day, response headers captured — if its Pelias version differs from our pin,
the local-vs-hosted delta contains version delta and is labeled so, not called pure scope cost).

**Panel:** the same 420-row file, hash-pinned. Every row carries two pre-hoc columns assigned
before any arm runs: `truth_type` (`rooftop / venue / city-only`) and `local_coverage_hint`
(`OA_point / TIGER_range / OSM_address / OSM_interpolation / WOF_only`). The @1km story lives or
dies on `truth_type` — reported per stratum, never blended silently.

**Scoring, locked before running:** top-1 result only; haversine; thresholds 1/5/25 km; no-result =
empty result array (a low-confidence fallback counts as a result and is ALSO reported as a
fallback-rate column); the exact same raw query string to all three arms — no per-arm
normalization; arms executed round-robin in one order; hosted responses cached with timestamps;
scorer deterministic (run twice, byte-identical), its command + hash recorded; bootstrap CIs
per-locale with pinned seed and resample count.

**The parity claim needs an equivalence bound, not a null result:** preregistered margin ±5 pp
@25km on the mailwoman-vs-local-Pelias difference, claimed only when the bootstrap CI on the
difference excludes a larger gap (TOST-style), per locale and pooled.

**Google stays an oracle:** flags rows for manual review (its distance >5 km from asserted truth),
never filters, relabels, or drops a row after scores exist. The oracle logic is this sentence.

**The scope-cost column:** local-Pelias vs hosted-Pelias delta, per locale — it measures what our
scoping removed and fences what the local numbers can claim.

## §5 — Pre-registration checklist (all written before the first import)

- [ ] pelias/docker commit + image digests
- [ ] Data manifest: SHA-256 for every OA CSV, WOF sqlite, TIGER shapefile, OSM PBF, polylines file
- [ ] `pelias.json` hash + compose overrides (`ES_JAVA_OPTS`, memory caps)
- [ ] Panel file hash; per-row `truth_type` + `local_coverage_hint` assigned
- [ ] Scoring definition (§4 verbatim), scorer command + hash, determinism check
- [ ] Distance formula + thresholds; no-result + tie-break definitions; equivalence margin
- [ ] Bootstrap seed + resamples
- [ ] §2 falsifier outcomes, graded
- [ ] §3 probe results per country
- [ ] Google-oracle logic; stop rule for failed country imports
- [ ] Hosted-arm response headers / version capture plan

## §6 — Consult calibration record

Session `019fd8b2-63e4-71f6-931b-0f197276cdf8`, three turns, flash tier.

- structural (adopted): one-project-one-index; keep placeholder + interpolation (skipping deflates
  the metric under comparison); sequential one-shot importers; the CONTROL critique (scoped-local
  vs stale-hosted is uncontrolled → the three-arm same-day design); `truth_type` +
  `local_coverage_hint` pre-hoc columns; equivalence-bound framing for any parity headline;
  Google-as-oracle-never-filter.
- factual claims → falsifiers (§2), graded before trust: interpolation-never-TIGER;
  polylines-planet-only; fits-in-16GB. Outcomes to be recorded here.
- quantitative predictions: none offered beyond the memory envelope (covered by §2c).
