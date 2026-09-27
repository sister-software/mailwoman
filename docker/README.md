# `ghcr.io/sister-software/mailwoman` — the container image

One `docker run` command starts a geocoding endpoint without a Node toolchain or a build step. The
image installs the **published** `@mailwoman/*` npm packages and includes the model weights, so the
container runs the same code an npm consumer gets. The gazetteer (the large geographic dataset) is
kept out of the image and mounts at `/data`.

The image is built from the repo-root [`Dockerfile`](../Dockerfile),
[`docker/package.json`](./package.json) (the exact dependency set), and
[`docker/server.mjs`](./server.mjs) (the entrypoint). CI publishes it with
[`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml).

## First run — parse works with no data

```bash
docker run --rm -p 3000:3000 ghcr.io/sister-software/mailwoman:latest

curl -s -X POST localhost:3000/v1/parse \
  -H 'content-type: application/json' \
  -d '{"address":"350 5th Ave, New York, NY 10118"}'
```

The parser needs only the included weights, so it answers immediately. Geocoding needs a gazetteer.
Until one is mounted, `/v1/geocode` and `/v1/batch` return a `503` (`{"error":"geocoder not
available", ...}`) instead of crashing. Parsing always works, and mounting data enables geocoding.

## Full geocoding — mount the gazetteer read-only

Point `/data` at a mailwoman data root (a `wof/candidate.db` plus optional per-state extracts):

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

If you do not have a gazetteer yet, pull the worldwide candidate DB (~1.65 GB, population-first
ranking) with the same image. The host does not need Node or npm for this step:

```bash
mkdir -p mailwoman-data
docker run --rm -v "$(pwd)/mailwoman-data:/data" \
  ghcr.io/sister-software/mailwoman:latest \
  node node_modules/mailwoman/out/cli.js data pull candidate
```

`data pull` writes the file under the container's `$MAILWOMAN_DATA_ROOT` (`/data`, set by the image),
at `/data/wof/candidate.db`. That is the path the read-only mount above expects. This one run needs
the volume **without** `:ro`. Every later `docker run` that only reads the gazetteer keeps `:ro`.

### Read-only mounts

Both backends open SQLite read-only, so `:ro` works for either. The recommended backend is the
**candidate** gazetteer (`MAILWOMAN_CANDIDATE_DB` / `wof/candidate.db`), which is worldwide and ranked
by population. The FTS admin backend (`MAILWOMAN_WOF_DB`) opens writable only when a caller
explicitly requests an FTS index build (`buildFTS`), and the server never does that.
`resolver-wof-sqlite/lookup.ts` has behaved this way since 2026-07-20. Earlier versions of this file
said the FTS backend always opened read-write. Two further issues can affect a mount:

- If `wof/candidate.db` is a **symlink**, set `MAILWOMAN_CANDIDATE_DB` to the real file path inside the
  container (e.g. `/data/wof/candidate-global-1026.db`). A symlink that points at an absolute host
  path is broken inside the container.
- Per-state rooftop extracts (`address-points/…`, `interpolation/…`) use WAL mode. They open read-only
  when their `-wal`/`-shm` sibling files are in the same mount. If a sibling file is missing, the
  address falls back to admin-level or street-level coordinates and the request still succeeds.

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

The container always listens on port **3000** internally. Remap it with `-p <host>:3000`.

## Drop-in servers (alternative commands)

The same image includes the drop-in replacement servers. Override the command to run one. Each server
uses its own port. The image's default HEALTHCHECK requests `:3000/health`, so override or disable it
when you change the command. The [`docker-compose.yml`](./docker-compose.yml) does this for each
service.

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

- The base image is `node:24-slim` (Debian with glibc), because onnxruntime-node's prebuilt binaries
  target glibc instead of musl.
- The container runs as the unprivileged `node` user.
- The image is `linux/amd64` only for now. arm64 support is planned and requires verifying the arm64
  ORT prebuild.
- The weights (`@mailwoman/neural-weights-en-us`) are included in the image, and the gazetteer is
  mounted as a volume.
