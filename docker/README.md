# `ghcr.io/sister-software/mailwoman` — the container image

`docker run` and you have a geocoding endpoint. No Node toolchain, no build — the image installs the
**published** `@mailwoman/*` npm packages and bakes the model weights in, so what you run is exactly
what an npm consumer gets. The gazetteer (the big geo data) stays out of the image and mounts at
`/data`.

Everything here is built from the repo-root [`Dockerfile`](../Dockerfile),
[`docker/package.json`](./package.json) (the exact dependency set), and
[`docker/server.mjs`](./server.mjs) (the entrypoint). CI publishes it via
[`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml).

## First run — parse works with no data

```bash
docker run --rm -p 3000:3000 ghcr.io/sister-software/mailwoman:latest

curl -s -X POST localhost:3000/v1/parse \
  -H 'content-type: application/json' \
  -d '{"address":"350 5th Ave, New York, NY 10118"}'
```

The parser needs only the baked-in weights, so it answers immediately. Geocoding needs a gazetteer you
haven't mounted yet, so `/v1/geocode` and `/v1/batch` answer a clean `503` (`{"error":"geocoder not
available", ...}`) instead of crashing. That's the batteries-included story: you can always parse; you
opt into geocoding by mounting data.

## Full geocoding — mount the gazetteer read-only

Point `/data` at a mailwoman data root (a `wof/candidate.db` plus optional per-state shards):

```bash
docker run --rm -p 3000:3000 \
  -v /path/to/mailwoman-data:/data:ro \
  -e MAILWOMAN_CANDIDATE_DB=/data/wof/candidate.db \
  ghcr.io/sister-software/mailwoman:latest

curl -s -X POST localhost:3000/v1/geocode \
  -H 'content-type: application/json' \
  -d '{"address":"350 5th Ave, New York, NY 10118"}'
# → { "lat": 40.74…, "lon": -73.98…, "resolution_tier": "interpolated", … }
```

Don't have a gazetteer yet? Grab the worldwide candidate DB (~1.4 GB, byte-range friendly):

```bash
mkdir -p mailwoman-data/wof
curl -fSL https://public.sister.software/mailwoman/gazetteer/2026-07-07a/candidate.db \
  -o mailwoman-data/wof/candidate.db
```

### Why read-only mounts need the candidate backend

The **candidate** gazetteer (`MAILWOMAN_CANDIDATE_DB` / `wof/candidate.db`) opens SQLite read-only, so
it works on a `:ro` mount — this is the recommended, worldwide, population-first backend. The FTS admin
backend (`MAILWOMAN_WOF_DB`) opens its shard **read-write**, so it fails on a `:ro` mount with `unable
to open database file`; mount read-write (drop `:ro`) if you specifically need the FTS backend. Two
gotchas worth naming:

- If `wof/candidate.db` is a **symlink**, set `MAILWOMAN_CANDIDATE_DB` to the real file path inside the
  container (e.g. `/data/wof/candidate-global-1026.db`). A symlink pointing at an absolute host path
  dangles inside the container.
- Per-state rooftop shards (`address-points/…`, `interpolation/…`) are WAL-mode. They open fine
  read-only when their `-wal`/`-shm` siblings are present in the same mount; a missing sidecar drops
  that address to admin/street-level coordinates rather than failing the request.

## The `/v1` surface (default server)

| Route           | Method    | Needs data | Notes                                   |
| --------------- | --------- | ---------- | --------------------------------------- |
| `/v1/parse`     | GET, POST | no         | weights-only                            |
| `/v1/geocode`   | POST      | yes        | `503` when no gazetteer                 |
| `/v1/batch`     | POST      | yes        | per-row error isolation; `503` when dry |
| `/v1/format`    | POST      | no         | always available                        |
| `/health`       | GET       | no         | the HEALTHCHECK target                  |
| `/metrics`      | GET       | no         | in-process latency/tier snapshot        |
| `/openapi.json` | GET       | no         | emitted OpenAPI document                |

The container always listens on **3000** inside; remap with `-p <host>:3000`.

## Drop-in servers (alternative commands)

The same image ships the drop-in replacements. Override the command to run one — each has its own port
and its own baked HEALTHCHECK caveat (the image's default HEALTHCHECK hits `:3000/health`, so override
or disable it when you change the command; the [`docker-compose.yml`](./docker-compose.yml) does this
per service).

```bash
# Nominatim-compatible — GET /search /reverse /lookup /status  (port 8080)
docker run --rm -p 8080:8080 -v /path/to/data:/data:ro \
  -e MAILWOMAN_CANDIDATE_DB=/data/wof/candidate.db \
  ghcr.io/sister-software/mailwoman:latest \
  node node_modules/@mailwoman/nominatim/out/cli.js serve

# Photon-compatible autocomplete — GET /api /reverse  (port 2322)
docker run --rm -p 2322:2322 -v /path/to/data:/data:ro \
  -e MAILWOMAN_CANDIDATE_DB=/data/wof/candidate.db \
  ghcr.io/sister-software/mailwoman:latest \
  node node_modules/@mailwoman/photon/out/cli.js serve

# libpostal-compatible — /parse /expand  (port 8081, no data needed)
docker run --rm -p 8081:8081 \
  ghcr.io/sister-software/mailwoman:latest \
  node node_modules/@mailwoman/libpostal/out/cli.js serve
```

Or bring the whole set up with compose:

```bash
MAILWOMAN_DATA_HOST=/path/to/mailwoman-data docker compose -f docker/docker-compose.yml up mailwoman
```

## Image facts

- Base `node:24-slim` (Debian, glibc — onnxruntime-node's prebuilds are glibc, not musl).
- Runs as the unprivileged `node` user.
- `linux/amd64` only for now; arm64 is a follow-up (needs the arm64 ORT prebuild verified).
- Weights baked in (`@mailwoman/neural-weights-en-us`); gazetteer volume-mounted.
