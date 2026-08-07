# `pelias-rig/` — the scoped local Pelias benchmark rig

The version-controlled half of the three-arm Pelias comparison preregistered in
[`docs/superpowers/plans/2026-08-06-local-pelias-benchmark-rig.md`](../docs/superpowers/plans/2026-08-06-local-pelias-benchmark-rig.md).
Read the plan first — it owns the scope, the falsifiers, the scoring definition and the equivalence
bound. This directory holds only what has to be reproducible: the panel, the panel builder, the
compose project, and the config generator.

**Everything else lives outside the repo**, at `$MAILWOMAN_DATA_ROOT/pelias-rig/`: the country PBFs,
the polyline cuts, the Elasticsearch index, the shallow clones of the upstream Pelias repos, the
fetch/cut shell drivers, and the logs. None of it is source, and it runs to tens of gigabytes.

## Layout

| Path                          | What it is                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `panel/build-panel.ts`        | Builds the panel from the repo's own coordinate-bearing goldens plus the OA countrywide dumps. Deterministic; one fixed seed. |
| `panel/panel-v1.jsonl`        | The 420-row panel. **Hash-pinned** — the sidecar is the contract, not the file's mtime.                                       |
| `panel/panel-v1.jsonl.sha256` | The pin.                                                                                                                     |
| `panel/panel-v1.manifest.json`| Seed, per-locale strata counts, US state lists, truth-type totals.                                                            |
| `project/docker-compose.yml`  | The compose project. Images pinned by DIGEST, podman-rootless-shaped.                                                         |
| `project/build-config.ts`     | Generates `project/pelias.json` from what is on disk. Re-run after every fetch.                                               |
| `project/image-digests.txt`   | The pinned digests, as pulled.                                                                                               |
| `project/env.defaults`        | Where the data is. `.env` is gitignored repo-wide, so this is the original — `cp env.defaults .env` first.                    |

## The panel

420 rows, 60 per locale across `en-us fr-fr de-de en-gb en-au en-nz eu-mixed` (the EU locale pools
AT/CH/CZ/DK/BE/NL). Each row carries the two pre-hoc columns §4 requires — `truth_type` and
`local_coverage_hint` — plus the truth coordinate, a tolerance where the source asserted one, and
the file+line it came from.

Two properties are worth knowing before reading any number off it:

- **The input strings are rendered, not copied.** The repo's coordinate goldens were built to stress
  the parser and cycle three orders on purpose, including forms no user types (`"Ansan, 32270,
  Route de Crastes 350"`). mailwoman was trained on those orders; Pelias was not. Feeding them to
  all three arms would hand our arm an advantage that is not geocoding. `build-panel.ts` keeps the
  truth and renders one natural postal order per country instead, identical for every arm.
- **The strata are uneven and stay uneven.** `venue` is small and lives only where the boards carry
  venue rows; NZ and AU have almost no admin-level board rows. Nothing is synthesized to even it
  out, and the report never blends strata.

Rebuild and verify:

```bash
node pelias-rig/panel/build-panel.ts        # deterministic — same seed, same bytes
sha256sum -c pelias-rig/panel/panel-v1.jsonl.sha256
```

## Runbook

The order below is the plan's §1 runbook with what the falsifiers changed, and with the corrections
the first import pass forced. Steps 1–4 are staging; step 5 is the import phase.

1. `$MAILWOMAN_DATA_ROOT/pelias-rig/pull-images.sh` — pull + record digests. Already done; re-run
   only to re-pin.
2. `$MAILWOMAN_DATA_ROOT/pelias-rig/cut-polylines.sh` — one `.0sv` per country PBF, smallest first,
   resumable via `markers/POLYLINE-<cc>-DONE`. Its sibling `cut-polylines-remaining.sh` enumerates
   `data/osm` instead of carrying a fixed list, so re-running it picks up any PBF that arrived
   later (the US state downloads); already-cut files are skipped.
3. `$MAILWOMAN_DATA_ROOT/pelias-rig/fetch-us.sh CA DC IA IL MI MT SD TN VT` — the panel-state
   fetches (Geofabrik PBFs, TIGER 2024 ADDRFEAT via `mailwoman tiger fetch`, the four OA US
   collections). The state list comes from `usStatesRequiringLocalSources` in the panel manifest,
   NOT from `usStates`: city-only rows are answered by the country-wide WOF load and pull in eight
   states that need no local sources at all.

   **`mailwoman tiger fetch` aborts a whole state on one bad zip.** It downloads and unzips, and a
   truncated archive kills the run — MI stopped at county 26075, MT at 30017, both reproduced on
   retry. Nothing downstream needs the unzip: `conflate_tiger.sh` globs the zips and pipes each
   through ogr2ogr itself. Fetching the county zips directly past the bad one gets MI to 82/83 and
   MT to 55/56; those two counties are corrupt at the census and stay recorded as gaps.

   The **whosonfirst SQLite bundles are NOT on disk** — the plan's §1 data table says "we hold them"
   and that is wrong for these twelve countries; `wof/repos/` carries GeoJSON repos for us/jp/kr/tw
   only. The importer downloads them itself: `podman-compose run --rm whosonfirst npm run download`
   honours the `countryCode` array and fetches 12 admin bundles (12.2 GB) into `data/whosonfirst/sqlite/`.
4. `node pelias-rig/project/build-config.ts` — regenerate `pelias.json` from disk, then
   `pelias-rig/project/sync-project.sh` to copy the project to its run location.
5. The imports, strictly one at a time:

   ```bash
   cd $MAILWOMAN_DATA_ROOT/pelias-rig/project
   podman-compose up -d elasticsearch                     # wait for status: green
   podman-compose run --rm schema ./bin/create_index
   ./run-import.sh whosonfirst                            # ~4 min, 588,500 docs
   ./run-import.sh openaddresses                          # the bulk
   ./run-import.sh polylines
   ./import-osm-per-country.sh                            # the long pole, one country per container
   ```

   then, from the repo:

   ```bash
   pelias-rig/interpolation/run-build.sh                  # interpolation, C-shape
   podman-compose up -d libpostal placeholder interpolation api
   ```

6. Per-country acceptance probes (§3): `python3 pelias-rig/project/acceptance-probes.py`. A country
   that fails is labeled `coverage-limited` and stays in the report — never silently re-run.

### Five upstream shapes that will bite whoever runs step 5

Four of these were measured the hard way on 2026-08-07.

- **Every importer image's default CMD is `bash`.** `podman-compose run --rm whosonfirst` with no
  command does not import — it opens an interactive shell and sits there, `podman ps` shows it Up,
  and the index stays empty. `run-import.sh` carries the command so a caller cannot omit it.
- **A read-only mount does not make a 0600 file readable.** The container runs as uid 1001 `pelias`,
  whose supplementary group is 1000 — the host user under `--userns=keep-id`. Group-readable input
  works; owner-only does not. 417 CSVs in the shared OpenAddresses extraction were 0600, and the
  importer read **13 of 311 files**, indexed 32,344,348 documents, and then died on the 14th. Thirty-
  two million documents does not read as a broken import; the only tell was `rc=1`.
  `run-import.sh` now preflights the whole input list against the `other`-read bit before starting.
- **A document count is not a coverage check.** Which is the general form of the above, and the
  reason `run-import.sh` records rc, wall time, and the before/after delta on every run.
- **`docker_build.sh` is single-country by construction.** It globs `${OSMPATH}/*.pbf` and
  `${POLYLINEPATH}/*.0sv` and uses **only the first of each**, warning about the rest.
  `interpolation/build-c-shape.sh` drives `script/`'s pieces directly instead.
- **There is no docker on this host.** podman 4.9.3 rootless + `podman-compose`, and every service
  that writes to a bind mount needs `userns_mode: keep-id` — already set in the compose file.

### The single merged polyline file is a correctness requirement

`api/polyline.js` assigns each street its id from `stream.polyline.autoincrement()` — the LINE NUMBER
in the stream it is fed — and `address.db`'s `id` column is that street id, the only thing tying an
address to a street. Nineteen separate polyline passes would restart numbering at 1 each time, so
street 42 in Germany and street 42 in Vermont become the same street and every address conflated
against one lands on the other. One stream, one id space: 5,013,305 streets from a 437 MB
concatenation of all nineteen cuts.

The address side is safe to loop, and its schema explains why. `address.db` carries
`UNIQUE(id, housenumber) ON CONFLICT IGNORE`: the primary key is a surrogate `rowid`, `source` and
`source_id` carry provenance in their own columns, so there is no cross-source id collision to
namespace away. What the constraint *does* mean is that for a given street and housenumber the FIRST
writer wins and every later pass is dropped in silence — which makes pass ORDER a precedence decision
rather than a scheduling detail. OpenAddresses first (surveyed points), TIGER second (ranges),
vertices last (synthesised fractional numbers at geometry vertices). A useful corollary: a surviving
row with `source = 'TIGER'` is by construction one OpenAddresses had nothing for, which is what
`make-interpolation-probes.py` uses instead of an absence query.
