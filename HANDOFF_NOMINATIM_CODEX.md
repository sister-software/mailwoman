# Nominatim arm handoff — what worked, what didn't, how to finish it

2026-08-08. Written after four failed attempts to build a scoped local Nominatim
instance as the third arm of a five-arm geocoding benchmark. The rig's Pelias and
mailwoman arms are frozen and scored. Nominatim is the open item.

## What the arm is for

A same-day controlled comparison between mailwoman 9.0.0 and a locally-built
Nominatim instance at the scope of our panel data (19 country/state PBF extracts,
~15 GB total). The benchmark protocol is locked in
`docs/superpowers/plans/2026-08-06-local-pelias-benchmark-rig.md`.

## What exists on disk

| Artifact                        | Path                                                                                  | Notes                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 19 Geofabrik PBFs               | `/mnt/playpen/mailwoman-data/pelias-rig/data/osm/`                                    | Properly ordered (individual extracts), validated                     |
| Merged PBF (unsorted, UNUSABLE) | `/mnt/playpen/mailwoman-data/pelias-rig/data/nominatim/merged-panel-unsorted.osm.pbf` | `osmium cat` output — nodes after relations; osm2pgsql refused it     |
| Compose project                 | `/mnt/playpen/mailwoman-data/pelias-rig/nominatim/docker-compose.yml`                 | mediagis/nominatim 4.5 + postgis 16-3.5, both digest-pinned           |
| Merge script                    | `/mnt/playpen/mailwoman-data/pelias-rig/nominatim/merge-pbfs.sh`                      | Works but produces unordered output (needs `osmium sort` after `cat`) |
| Rebuild script                  | `/mnt/playpen/mailwoman-data/pelias-rig/nominatim/rebuild-nominatim.sh`               | Resumable per-country import, markers, flatnode disabled              |
| osmium shim                     | `/tmp/osmium-shim/osmium`                                                             | Extracted from Ubuntu .debs, no passwordless sudo on host             |
| local.php                       | `/mnt/playpen/mailwoman-data/pelias-rig/nominatim/nominatim/local.php`                | Forward-only, flatnode path                                           |
| OPERATOR-NOTES                  | `/mnt/playpen/mailwoman-data/pelias-rig/logs/OPERATOR-NOTES.md`                       | Full incident log                                                     |

## What worked

1. **Per-country PBFs import cleanly.** Individual Geofabrik extracts are
   properly ordered (nodes → ways → relations). The merged file from `osmium cat`
   was NOT ordered — do not use it. Import one country at a time, smallest first.

2. **The flatnode file MUST be disabled.** It is sized for the planet's node-ID
   space (105 GB for this panel) and saturates NVMe random-read I/O — appends
   collapsed from 74,700 nodes/sec to 300/sec with it on, and recovered to 84,500
   nodes/sec with it off. Set `NOMINATIM_FLATNODE_FILE=""` and use
   `--osm2pgsql-cache 8000` to hold the node set in RAM. The Pelias stack must
   be stopped first (4 GB ES + services ≈ 7 GB) so the 8 GB cache has headroom.

3. **A first country imports in 59 minutes** via the compose entrypoint without
   flatnode (NZ, 383 MB). This is the create pass — it builds the schema, country
   tables and initial indexes.

4. **Subsequent countries append** via `nominatim add-data --file <pbf>` (NOT
   `--osm-file`). The append must run inside the `nominatim` container:
   ```bash
   podman exec nominatim bash -c "
     sudo -E -u nominatim nominatim add-data \
       --file /data/osm/denmark-latest.osm.pbf --threads 2 --osm2pgsql-cache 8000
   "
   ```

## What failed and why

| Attempt                     | Failure                                          | Root cause                                                                                                                              |
| --------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Merged PBF import           | "Input data is not ordered: node after relation" | `osmium cat` concatenates in filesystem order, not node/way/relation order                                                              |
| `osmium sort` of merged PBF | OOM-killed                                       | 15 GB file needs ~15 GB RAM; host has ~10-12 GB available beside running services                                                       |
| Denmark append (first try)  | Flag error: `--osm-file` not recognized          | The `nominatim import` entrypoint flag is `--osm-file`; `nominatim add-data` uses `--file`                                              |
| Denmark append (second try) | 250× rate collapse: 74,700 → 300 nodes/sec       | 105 GB flatnode file doing random NVMe reads per node lookup                                                                            |
| Compose daemon restart      | Lost the 9-hour NZ database                      | `podman rm -f` on the old container: the database was in the container's ephemeral storage, not in the persistent postgres volume mount |

## Why the database was lost

The compose has TWO postgres instances:

1. **`nominatim-postgres`** — external container, bind mount at
   `../data/nominatim/postgres:/var/lib/postgresql/data:rw` (persistent)
2. **Internal postgres inside the `nominatim` container** — the mediagis entrypoint
   starts its own postgres during import (ephemeral — destroyed on container removal)

The `nominatim` service sets `POSTGRES_HOST: nominatim-postgres`, but the
entrypoint's `nominatim import` script connects to LOCALHOST postgres — the one
inside the same container. The external postgres container was never written to.

**To fix:** the create import must point at the external postgres. Either (a) run
`nominatim import` directly against `nominatim-postgres:5432` instead of localhost,
or (b) drop the external postgres container entirely and use a named volume for
the nominatim container's internal postgres data dir. Option (b) is simpler:
remove the `nominatim-postgres` service from the compose, replace the separate
postgres data mount with a named volume on the `nominatim` service for
`/var/lib/postgresql/16/main`.

## Known traps (read before touching anything)

1. **Network name.** The Pelias stack runs as compose project `project`, so its
   network is `project_default` — not `pelias_default`. The compose declares an
   external network with `name: project_default` to match.
2. **Port 8080.** Taken by an unrelated service (girlbossru.sh container host).
   Nominatim API is exposed on `127.0.0.1:8081`.
3. **`userns_mode: keep-id` breaks the mediagis entrypoint.** It needs real root
   to `useradd` and `sed /nominatim`. Removed from the compose.
4. **local.php mount.** The entrypoint runs `chown -R /nominatim`, which EPERMs
   on a lab-owned bind mount. Fix: mount rw and `podman unshare chown 1:1` the
   host file so container root (host subuid) owns it.
5. **No osmium on host, no passwordless sudo.** Extracted from Ubuntu .debs into
   `/tmp/osmium-extract`; the shim at `/tmp/osmium-shim/osmium` sets
   `LD_LIBRARY_PATH`.
6. **Append flag is `--file`, not `--osm-file`.** The import subcommand uses
   `--osm-file`; the add-data subcommand uses `--file`. Getting this wrong gives
   a usage error and immediate exit.
7. **Flatnode: disable it.** `NOMINATIM_FLATNODE_FILE=""` and
   `--osm2pgsql-cache 8000`. The flatnode is sized for planet-scale imports and
   destroys append throughput on a panel of country extracts.

## Suggested path forward

Given that:

- Per-country imports work
- The database loss was a known compose trap, not a fundamental problem
- The rebuild script already handles resumable markers, crash recovery and the
  correct flags per mode
- The panel data is 19 PBFs, ~15 GB, comfortably fitting 8 GB of node cache

Either:

**A — Quick, minimal, shipped today:**

```bash
# 1. Reset and rebuild (the script already does everything except the volume fix)
cd /mnt/playpen/mailwoman-data/pelias-rig/nominatim
bash rebuild-nominatim.sh --reset

# 2. Fix the volume: after the FIRST country (NZ) completes via compose run,
#    the container will block serving the API. At that point, the database is
#    alive inside the nominatim container. BACK IT UP:
#    podman exec nominatim bash -c "pg_dump -U nominatim nominatim" > /tmp/nominatim-dump.sql
#    Then kill the container, restart via compose, and restore.

# 3. OR, simpler: edit the compose to drop the external postgres and use a
#    named volume for the nominatim container's internal postgres. Then the
#    rebuild script's markers + resume logic handles everything else.

# 4. OR, simplest: accept NZ-only for the Nominatim arm. The preregistration
#    (§3 stop rule) allows `coverage-limited` labeling. Restart the daemon
#    container serving from the NZ-only database (if it still exists anywhere),
#    or rebuild NZ quickly (59 min), run the probes, label and freeze.
```

**B — Full 19-country build with the compose volume fixed.** ~6-12 hours
wall-clock, resumable. The flatnode lesson and the compose volume trap are the
two things that need to be right. Everything else in the script is correct.

## Host reference

- Host: rootless podman + podman-compose, NOT docker
- RAM: 29 GB total, ~16 GB usable beside existing services
- Disk: /mnt/playpen (NVMe), 954 GB, ~360 GB free
- Pelias stack: currently stopped (containers preserved — restartable for scoring)
- Pelias frozen index: 187.8M docs at localhost:9200
