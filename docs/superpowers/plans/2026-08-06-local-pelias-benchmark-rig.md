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

### Graded outcomes (2026-08-07)

- **(a) interpolation-never-TIGER — FALSE, with a catch that keeps the scope decision alive.**
  `pelias/interpolation` ships a TIGER conflation step (`./interpolate tiger address.db street.db`,
  driven by `script/conflate_tiger.sh`), so TIGER address ranges DO feed interpolation. But they feed
  the ADDRESS side only: `street.db` is built by `script/import.sh` from the polylines file, and the
  conflation needs it to attach ranges to. **TIGER cannot replace polylines; it enriches them.** So a
  US arm with interpolation still needs a US polylines cut — which is affordable, see (b).
  Two side-findings that change the runbook: `conflate_tiger.sh` globs `$TIGERPATH/downloads/**/*.zip`
  and pipes each through `ogr2ogr`, so our OWN TIGER 2024 county zips can be mounted straight in;
  and interpolation's own downloader (`script/js/update_tiger.js`) is pinned to **TIGER2021** via a
  `data.geocode.earth` mirror, so we do not use it. Vintage note for §1's data table: what we held on
  disk was TIGER 2024 ADDRFEAT for **one county** (DC 11001) plus TIGER 2020 for CA — the rest is
  being fetched per panel state.
- **(b) polylines-planet-only — FALSE. Per-country cuts work, and the 1 GB guard is soft.**
  `pelias/polylines`' `docker_extract.sh` runs `pbf streets` (missinglink/pbf) per PBF and warns off
  files over 1 GB — and its guard is broken anyway (`exit 1` inside a `find | while read` subshell
  exits the subshell, not the script, so it warns and proceeds). Driving `pbf streets` directly, one
  country at a time, **all ten countries cut cleanly**: nz 8.0 MB/25 s, cz 7.5 MB/34 s, dk
  13.1 MB/35 s, be 13.4 MB/46 s, ch 14.7 MB/46 s, at 16.3 MB/56 s, nl 19.5 MB/71 s, au 44.8 MB/113 s,
  **gb 66.4 MB/188 s from a 2.16 GB PBF, de 104.8 MB/732 s from a 4.81 GB PBF at ~7 GB peak RSS**.
  So the 1 GB line is not where the tool breaks — it did not break at 4.8× that on a 29 GB host, and
  the memory ceiling the warning gestures at was never reached. The full ladder is in
  `$MAILWOMAN_DATA_ROOT/pelias-rig/logs/polyline-status.txt`.
  One departure from the stock script: it concatenates every PBF into a single `extract.0sv`, and
  `docker_build.sh` then uses **only the alphabetically first `.pbf` and first `.0sv` it finds** —
  single-country by construction. A multi-country interpolation build has to drive `script/build.sh`
  itself.
- **(c) fits-in-16 GB — precondition CLEARED, full probe pending imports.** The fail-fast check
  passes: `pelias/elasticsearch:7.17.27` bakes `ES_JAVA_OPTS=-Xms512m -Xmx512m`, well under the 8 GB
  abort line, so the compose override to 4 GB raises the heap rather than fighting a large default.
  The under-load measurement waits for the first importer run.
- **Unplanned, and it reshapes the runbook: THERE IS NO DOCKER ON THIS HOST.** Only podman 4.9.3
  rootless plus `podman-compose`. Every service that writes to a bind mount needs
  `userns_mode: keep-id` — measured, not guessed: the first polyline cut died instantly with
  `/out/nz.0sv: Permission denied` and succeeded unchanged once keep-id was added.

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

- [x] pelias/docker commit + image digests — commit `3dfa07d580416edd7a27c2d4ff5976c8c1cc6ebc`;
      all ten image digests recorded in `pelias-rig/project/image-digests.txt` and pasted into the
      compose file, which references digests only (no `:master` anywhere)
- [ ] Data manifest: SHA-256 for every OA CSV, WOF sqlite, TIGER shapefile, OSM PBF, polylines file
- [ ] `pelias.json` hash + compose overrides — compose overrides done (`ES_JAVA_OPTS=-Xms4g -Xmx4g`,
      1 GB caps on api/placeholder, 2 GB on libpostal, importers uncapped); `pelias.json` is
      GENERATED from disk by `pelias-rig/project/build-config.ts` and hashes once the fetches land
- [x] Panel file hash; per-row `truth_type` + `local_coverage_hint` assigned — `panel-v1.jsonl`,
      420 rows, seed 20260807, hash + strata in `pelias-rig/panel/panel-v1.manifest.json`
- [ ] Scoring definition (§4 verbatim), scorer command + hash, determinism check
- [ ] Distance formula + thresholds; no-result + tie-break definitions; equivalence margin
- [ ] Bootstrap seed + resamples
- [x] §2 falsifier outcomes, graded — see the graded block in §2
- [ ] §3 probe results per country
- [ ] Google-oracle logic; stop rule for failed country imports
- [ ] Hosted-arm response headers / version capture plan

### Panel v1, as built (2026-08-07)

420 rows, 60 per locale, `sha256` in the manifest. Strata are UNEVEN and reported that way:

| locale     | rooftop | venue | city-only |
| ---------- | ------: | ----: | --------: |
| `en-us`    |      45 |     4 |        11 |
| `fr-fr`    |      48 |     2 |        10 |
| `de-de`    |      49 |     0 |        11 |
| `en-gb`    |      45 |     4 |        11 |
| `en-au`    |      56 |     0 |         4 |
| `en-nz`    |      57 |     0 |         3 |
| `eu-mixed` |      45 |     0 |        15 |

Recorded shortfalls, none padded: the venue stratum exists only where a board carried venue rows
(10 rows total, US/FR/GB) — the repo holds no venue-rooftop truth anywhere, and `poi-board.jsonl`'s
`anchorGold` points are city anchors for "near X" queries, not venue coordinates. AU and NZ have
almost no admin-level board rows (4 and 3), so their 60 is made up of rooftop. NZ had **zero**
coordinate-bearing address rows in the repo and `build-oa-coord-golden.ts` cannot make one — it
requires a POSTCODE and the OA NZ dump ships that column empty (measured: it wrote 0 rows) — so NZ
and AU rooftop truth is drawn straight from the OA countrywide dumps, reservoir-sampled and rendered
in national order.

**The panel's input strings are RENDERED from truth components, not copied from the goldens.** The
`oa-*-coord-*.jsonl` rows cycle three orders on purpose to stress the parser, including forms nobody
types (`"Ansan, 32270, Route de Crastes 350"`), and mailwoman was trained on those orders while
Pelias was not — feeding them to all three arms would be an uncontrolled advantage to our own arm.
One natural postal order per country, identical for every arm, keeps §4's same-string rule intact
without importing that bias.

**US scope: 9 states, not 17.** Every US panel row lands somewhere (17 states across all 60 rows),
but a `city-only` row is answered from the WOF admin hierarchy, which the whosonfirst importer loads
country-wide from one `countryCode` download — no state PBF, no TIGER county, no OA state directory.
Only the point-bearing rows (`rooftop` + `venue`) need per-state sources:
**CA, DC, IA, IL, MI, MT, SD, TN, VT**. Seven of those come from the rooftop draw; MI and TN enter
solely through venue rows, which is the concrete reason the venue stratum had to be classified before
the fetch list was computed rather than after. Both lists are in the panel manifest, so the scoping
is auditable rather than asserted.

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
