# The local Pelias benchmark rig — preregistration

Opened 2026-08-06 from the operator's directive. The distance-to-done review had found, the same day, that
bar (b), Pelias parity, is _unknown, last known behind_. That status rested on a 45-day-old
measurement of a model four major versions old. The fix is a reproducible, pinned, local Pelias
under Docker Compose, scoped to the data we hold, plus a three-arm controlled comparison against
mailwoman 9.0.0 and same-day hosted geocode.earth.

Method notes: the design came from a three-turn DeepSeek consult (session
`019fd8b2-63e4-71f6-931b-0f197276cdf8`). Following the consult calibration practice, the plan adopts
the consult's structural contributions. Its three required factual claims are **preregistered as
falsifiers to run before any import** (§2) rather than trusted. Nothing below runs until the
falsifiers are graded.

## §1 — The build, scoped

**Panel countries:** US, FR, DE, GB, AU, NZ + AT/CH/CZ/DK/BE/NL (city-level EU panel). The rig
covers forward geocoding only.

**Services:**

- Elasticsearch (heap pinned 4 GB, `number_of_extracts: 1`, `number_of_replicas: 0`) plus the
  one-shot schema job.
- api and libpostal.
- placeholder. The importers consult it for the admin hierarchy, and keeping it is cheaper than
  proving they don't need it.
- interpolation (**required**). A street-centroid fallback would deflate the exact @1km metric
  under comparison.

PIP is omitted because the rig does no reverse geocoding. The build uses one custom project and one
ES index. At 420 queries, separate per-country projects would add complexity without adding
accuracy.

**Pinning:** the `pelias/docker` release is pinned by commit and image digests, never by floating
tags. Data vintages are pinned by a SHA-256 manifest (§4).

**Data mapping (ours → Pelias):**

| Source          | Ours                                                                    | Pelias path                                                                                    |
| --------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| WOF admin       | official per-country `whosonfirst-data-admin-XX` SQLites (we hold them) | `data/whosonfirst` verbatim — our combined 5.3 GB product is not used                          |
| OpenAddresses   | standard-schema per-country CSVs (~20 countries held)                   | `data/openaddresses` verbatim; fetch `us` + `fr` (OA-fr ≈ BAN, which is upstream of it)        |
| TIGER           | 2024 shapefiles                                                         | `pelias/tiger` importer; 2020 unused                                                           |
| GNAF (AU)       | derived, non-official schema                                            | not used — OA au countrywide instead                                                           |
| Code-Point Open | postcode centroids                                                      | not used (no importer; postcode-level anyway)                                                  |
| OSM             | none on disk                                                            | Geofabrik country PBFs: DE, GB, AT, CH, CZ, DK, BE, NL, AU, NZ (+US pending the §2 falsifiers) |

**Per-country @1km attribution, assigned pre-hoc.** The table records which data the metric will
depend on in each country and where the scoped build diverges from hosted geocode.earth:

| Country  | @1km rides on                          | Scoped-build divergence risk                                                                         |
| -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| US       | TIGER ranges, then OA points, then OSM | if US OSM is skipped: venue rows suffer + no interpolation (see §2a/b) — annotate `TIGER+OA, no OSM` |
| FR       | OA/BAN points                          | low — expect strong @1km                                                                             |
| GB       | OSM address nodes + interpolation      | **OSM required**; OA-gb sparse                                                                       |
| DE       | OSM address nodes + interpolation      | **OSM required**; OA-de patchy                                                                       |
| AU, NZ   | OA countrywide points                  | low; OSM optional                                                                                    |
| EU panel | OSM address nodes + interpolation      | **all six small PBFs required**                                                                      |

**Memory limits (29 GB host, ~16 GB usable):** importers run as one-shot `docker compose run --rm`
jobs, strictly one at a time. The api and interpolation services stay down during imports. ES runs
with `-Xms4g -Xmx4g`, and each Node service is capped at ≤1 GB.

**Runbook (after §2 clears):**

1. Fetch the PBFs.
2. Place the OA CSVs, one per country. The importer selects files by filename.
3. Place the WOF sqlites.
4. Place TIGER 2024.
5. Write `pelias.json`. Its imports block lists the whosonfirst, openstreetmap, openaddresses,
   tiger and polylines datapaths and file lists.
6. Start ES and wait for green status.
7. Run schema, then whosonfirst.
8. Start placeholder.
9. Run openaddresses, then tiger.
10. Run openstreetmap per country, one at a time. This is the longest step.
11. Run polylines, only if §2b passes.
12. Build interpolation.
13. Start libpostal, interpolation and api.
14. Run the per-country probes (§3).
15. Freeze the build.

## §2 — Falsifiers: run these first, re-scope on failure

The plan depends on three factual claims. Each gets a ≤30-minute probe, graded and recorded here
before any import runs:

- **(a) `pelias/interpolation` builds only from polylines (OSM centerlines), never TIGER.**
  Probe: shallow-clone `pelias/interpolation`, run `grep -Ril tiger`, and read the README data
  section. If TIGER can feed it, the US can keep interpolation without US OSM, which shrinks the
  scope considerably.
- **(b) `pelias/polylines` may accept only a planet file rather than per-country files.** Probe:
  shallow-clone it, grep for the `files` config key, and read the download script. If per-country
  files work, US interpolation is affordable. If it is planet-only, the US row is annotated
  `no-interpolation`, or we hand-reduce a US polylines file as an added build step decided at that
  point.
- **(c) The runtime fits in ~16 GB with sequential imports.** Probe: set the caps, bring the runtime
  stack up, and run one small importer (NZ OSM) under `docker stats`. Check the compose file's
  default ES heap first, and stop early if it exceeds 8 GB.

## §2b — Falsifier outcomes (graded 2026-08-06/07, before any import)

- **(a) Falsified, in our favor.** `pelias/interpolation` conflates TIGER (`cmd/tiger.js`,
  `bin/download-tiger`) and OA (`script/conflate_oa.sh`) directly into its build. The street base
  comes from polylines, and OA/OSM/TIGER house numbers are conflated onto it. The US keeps
  interpolation without a US OSM Elasticsearch import.
- **(b) Falsified, in our favor.** Per-country polyline extraction from any PBF is documented
  (`docker_extract.sh`, osmium-based), and pre-reduced regional extracts exist. The build does not
  need a planet file.
- **(c) Holds with an override.** `pelias/docker`'s large projects default to
  `ES_JAVA_OPTS=-Xmx8g`, and our project pins 4g. The runtime smoke test is deferred to staging as
  planned.
- **(d) New, from check-in 1 (pro).** `pelias/api` checks interpolation on
  `hasResultsAtLayers('street')` (`routes/v1.js:182-187`). OA and TIGER emit only address-layer
  docs, so a US build without street docs would never trigger interpolation. The plan now covers
  this: the `polylines` importer writes those street-layer ES docs, and one per-state polyline
  reduce feeds both the ES street layer and the interpolation graph.
- **(e) WOF importer scoping (check-in 2 probe).** `imports.whosonfirst.countryCode` accepts an
  array of ISO codes, so the importer's own download is country-scoped. The importer will not pull
  the planet, and the files need no manual placement. This replaces the earlier manual-placement
  caution.

**Staging state (2026-08-07):**

- All 10 country PBFs are downloaded (12.2 GB, resumable, marker present).
- OA fr and de are extracted from europe.zip. GB needs no OA because it relies on OSM.
- US scope is limited to the panel states. The panel is the preregistered population, so this is a
  sampling frame rather than post-hoc cleanup. The state list is derived from the truth
  coordinates, never from query strings, and is verified before scoring. The US index is annotated
  "US subset: N states".
- Remaining fetches are panel-state OA-us, TIGER ADDRFEAT counties, and per-state PBFs for the
  polyline reduces. All of them wait on panel reconstruction.

## §3 — Per-country acceptance probes (before any benchmark row)

1. A known OA/TIGER rooftop address → `layer: address`, under 50 m.
2. An interpolation-class address (no point record) → `address`/`street` with an interpolated
   point, under 1 km.
3. A city-only query → locality match, never empty.

A country that fails its probes is marked `coverage-limited` and stays in the report with that
label. **It is never silently re-run or dropped** (preregistered stop rule).

## §4 — The three-arm protocol

**Arms:**

- mailwoman 9.0.0 (local, production defaults).
- Scoped local Pelias (this build).
- Hosted geocode.earth, queried the same day with response headers captured. If its Pelias version
  differs from our pin, the local-vs-hosted delta includes a version difference, and the report
  labels it that way rather than calling it pure scope cost.

**Panel:** the same 420-row file, hash-pinned. Before any arm runs, every row gets two pre-hoc
columns: `truth_type` (`rooftop / venue / city-only`) and `local_coverage_hint`
(`OA_point / TIGER_range / OSM_address / OSM_interpolation / WOF_only`). The @1km result depends on
`truth_type`, so it is reported per stratum and never silently blended.

**Scoring, locked before running:**

- Only the top-1 result counts.
- Distance is haversine, with thresholds at 1/5/25 km.
- A no-result is an empty result array. A low-confidence fallback counts as a result and is also
  reported in a fallback-rate column.
- All three arms get the exact same raw query string, with no per-arm normalization.
- Arms run round-robin in one fixed order.
- Hosted responses are cached with timestamps.
- The scorer is deterministic (two runs produce byte-identical output), and its command and hash are
  recorded.
- Bootstrap CIs are computed per locale with a pinned seed and resample count.

**The parity claim needs an equivalence bound rather than a null result.** The preregistered margin
is ±5 pp @25km on the mailwoman-vs-local-Pelias difference. Parity is claimed only when the bootstrap
CI on the difference excludes a larger gap (TOST-style), per locale and pooled.

**Google serves only as an oracle.** It flags rows for manual review when its result is >5 km from
the asserted truth. It never filters, relabels, or drops a row after scores exist. This sentence is
the entire oracle rule.

**The scope-cost column** reports the local-Pelias vs hosted-Pelias delta per locale. It measures
what our scoping removed and limits what the local numbers can claim.

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

- Structural contributions (adopted): one project with one index. Keep placeholder and
  interpolation, because skipping them deflates the metric under comparison. Run one-shot importers
  sequentially. The control critique: comparing a scoped local build against a stale hosted result
  is uncontrolled, which led to the three-arm same-day design. The `truth_type` and
  `local_coverage_hint` pre-hoc columns. An equivalence bound for any parity headline. Google as an
  oracle that never filters.
- Factual claims, turned into falsifiers (§2) and graded before being trusted: interpolation never
  uses TIGER, polylines accepts only a planet file, and the build fits in 16 GB. The outcomes are
  recorded in §2b.
- Quantitative predictions: the consult offered none beyond the memory envelope, which §2c covers.

## §7 — Scope addition (2026-08-07, operator): local Nominatim + Photon arms

These arms use the same panel, host and PBFs. One download feeds all three systems.

- **Nominatim:** `mediagis/nominatim-docker`, pinned by release tag, with one Postgres instance. The
  panel PBFs are combined with `osmium cat`. The regions need not be contiguous, so adjacent US
  states can be added if truth points lie near a border. The flatnode file lives on NVMe, with
  `shared_buffers` at 2–4 GB and `maintenance_work_mem` at 1–2 GB. Nominatim indexing, rather than
  PBF loading, dominates wall time. The exact `osmium cat` command and import parameters join the §5
  pin list.
- **Photon:** Photon builds its Lucene index from the Nominatim Postgres by exporting it and then
  serving the index standalone. `komoot/photon` is pinned, and its JVM is capped at 6–8 GB. It runs
  alone, with the Postgres buffers lowered. Every practical path requires Nominatim.
  `photon.komoot.io` is an unpinned reference only and is never a scored arm.
- **Ordering, one step at a time:** Pelias imports → Nominatim import → Photon export. At 16 GB the
  steps cannot overlap.
- **Arms:** five scored arms: mailwoman 9.0.0, local Pelias, local Nominatim, local Photon, and
  hosted geocode.earth (the primary hosted arm). Public nominatim.openstreetmap.org at 1 rps serves
  only as a sanity check.
- **New pre-registration columns**, because the scope-cost column alone cannot separate scoped data
  from version drift: `system_scope` (planet vs country-subset), `source_vintage`,
  `interpolation_enabled` (Pelias arms), `result_type` (address/street/locality/POI), and
  `response_version` (hosted captures).
