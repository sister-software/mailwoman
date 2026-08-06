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

Imports have NOT run yet. The order below is the plan's §1 runbook with what the falsifiers changed:

1. `$MAILWOMAN_DATA_ROOT/pelias-rig/pull-images.sh` — pull + record digests. Already done; re-run
   only to re-pin.
2. `$MAILWOMAN_DATA_ROOT/pelias-rig/cut-polylines.sh` — one `.0sv` per PBF, smallest first,
   resumable via `markers/POLYLINE-<cc>-DONE`. **US state PBFs still need their own pass.**
3. `$MAILWOMAN_DATA_ROOT/pelias-rig/fetch-us.sh CA DC IA IL MI MT SD TN VT` — the panel-state
   fetches (Geofabrik PBFs, TIGER 2024 ADDRFEAT via `mailwoman tiger fetch`, the four OA US
   collections). The state list comes from `usStatesRequiringLocalSources` in the panel manifest,
   NOT from `usStates`: city-only rows are answered by the country-wide WOF load and pull in eight
   states that need no local sources at all.
4. `node pelias-rig/project/build-config.ts` — regenerate `pelias.json` from disk.
5. ES up → wait green → `schema` one-shot → `whosonfirst` → placeholder up → `openaddresses` →
   `openstreetmap` (the long pole, sequential) → polylines → interpolation build → api up.
6. Per-country acceptance probes (§3). A country that fails is labeled `coverage-limited` and stays
   in the report — never silently re-run or dropped.

### Two upstream shapes that will bite whoever runs step 5

- **`docker_build.sh` is single-country by construction.** It globs `${OSMPATH}/*.pbf` and
  `${POLYLINEPATH}/*.0sv` and uses **only the first of each**, warning about the rest. A
  multi-country interpolation build has to call `script/build.sh` directly with an explicit
  `POLYLINE_FILE` (the cuts concatenate — `.0sv` is line-delimited) and then re-run
  `script/conflate_osm.sh` per remaining PBF.
- **There is no docker on this host.** podman 4.9.3 rootless + `podman-compose`, and every service
  that writes to a bind mount needs `userns_mode: keep-id` — already set in the compose file.
