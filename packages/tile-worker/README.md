# @mailwoman/tile-worker

This package serves map tiles, terrain tiles and database byte ranges through a Cloudflare Worker.

This workspace is private. Its deployment configuration is in `wrangler.toml`.

## Routes

All registered routes accept GET and HEAD. The app also handles CORS preflight
requests.

| Path                                                              | Response                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| `/`                                                               | Worker identity and diagnostic fields.                         |
| `/heartbeat`                                                      | Plain-text `OK`.                                               |
| `/<tileset>.json`                                                 | TileJSON metadata from a PMTiles archive.                      |
| `/<tileset>/<z>/<x>/<y>.<extension>`                              | One map tile.                                                  |
| `/tiger/<state>/<tileset>.json`                                   | TIGER tileset metadata.                                        |
| `/tiger/<state>/<tileset>/<z>/<x>/<y>.<extension>`                | One TIGER tile.                                                |
| `/providers/<provider>/<state>/<tileset>.json`                    | Provider tileset metadata.                                     |
| `/providers/<provider>/<state>/<tileset>/<z>/<x>/<y>.<extension>` | One provider tile.                                             |
| `/terrain/terrarium/<z>/<x>/<y>.png`                              | A proxied Terrarium elevation tile.                            |
| `/db/<file>`                                                      | A database byte range from R2.                                 |
| `/geolocate`                                                      | Approximate location derived from Cloudflare request metadata. |

See [the route definitions](lib/app.ts) for allowed path characters.
`/geolocate` returns HTTP 424 when Cloudflare metadata is unavailable.
A valid map-tile request for which the archive has no tile returns HTTP 204.
Terrain requests support zoom levels 0 through 15.

## Storage configuration

[`wrangler.toml`](wrangler.toml) declares these bindings:

| Configuration key        | Meaning                                              |
| ------------------------ | ---------------------------------------------------- |
| `MAILWOMAN_TILES_BUCKET` | R2 bucket containing PMTiles and database artifacts. |
| `PMTILES_PATH`           | Prefix for PMTiles keys, currently `tiles`.          |
| `main`                   | Compiled Worker entry, `./out/_worker.js`.           |

The configured Worker name is `mailwoman-tiles`, and its configured custom
domain is `tiles.mailwoman.ai`. These values come from the checked-in
configuration. Check the deployed service separately to establish its health.

A tileset called `planet.v4` resolves to
`tiles/planet.v4.pmtiles` with the current prefix. TIGER and provider routes
extend that key with their route directories.
Database requests read `db/<file>` independently of `PMTILES_PATH`.

A database GET requires a supported `Range` header and returns HTTP 206.
A database HEAD advertises range support without reading R2, so it does not
confirm that the object exists. Database responses bypass the response cache.
Tile and TileJSON responses use the Worker cache.

## Develop and verify

Compile from the repository root before starting Wrangler, because its entry
points to emitted JavaScript:

```bash
yarn ci:workers
yarn workspace @mailwoman/tile-worker exec wrangler dev
```

Provide the R2 objects needed by the routes you exercise. A Worker that starts
successfully can still lack a requested archive or database.

Run the package tests from the repository root:

```bash
yarn test --run packages/tile-worker
```

`createTileWorkerApp({ cache })`, exported from
`@mailwoman/tile-worker/app`, accepts a response-cache implementation for tests.
The tests use storage and cache substitutes to exercise request behavior.

## Deploy

With Cloudflare credentials and the intended bucket and domain configured, compile
with `yarn ci:workers` before deployment. The deploy command publishes the Worker
and applies its Wrangler configuration:

```bash
yarn workspace @mailwoman/tile-worker exec wrangler deploy
```

Upload map and database artifacts separately. The deployment command publishes
the Worker code and configuration. Build data artifacts through their owning packages.

## License

The package declares `AGPL-3.0-only OR LicenseRef-Commercial`.
