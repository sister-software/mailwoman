# sqlite-wasm + sql.js-httpvfs spike against real WOF

**Question**: is browser-native lookup over a 3GB+ WOF SQLite file viable for the public demo, or do we need a server fallback?

**Method**: serve the real `whosonfirst-data-admin-us-latest.db` (with `place_search` FTS5 + `place_bbox` R\*Tree pre-built per [`../README.md`](../README.md)) over HTTP with byte-range support, load it via [`sql.js-httpvfs`](https://github.com/phiresky/sql.js-httpvfs) in a headless Chromium, run a fixed set of representative queries, and capture cold/warm latency + bytes-fetched + HTTP round-trips per query.

**Setup**:

- `server.mjs` — Node http server with byte-range support, serves the .db
- `index.html` + `client.mjs` — page that loads sql.js-httpvfs and runs measurements
- `run.mjs` — orchestrator: spawns server, launches Playwright Chromium, captures network log + console output, writes `results.json` + `RESULTS.md`

**Run**:

```bash
cd resolver-wof-sqlite/spike
npm install --no-workspaces   # --no-workspaces: this lives inside the yarn-4 monorepo, whose
                              # workspace:* protocol npm can't resolve; we only want the two leaf deps
node run.mjs --db /path/to/wof-hot.db   # or any prepared SQLite (see "DB prep" below)
# → results.json + RESULTS.md in the same directory
```

**DB prep** (per the sql.js-httpvfs guidance — do this before serving):

```bash
sqlite3 wof.db "pragma journal_mode=delete; insert into place_search(place_search) values('optimize'); vacuum;"
# Keep the default page_size=4096: measured 4096 → 38 req / 3.6 MB vs 1024 → 43 req / 7.2 MB for our
# access pattern at a 64 KiB requestChunkSize. The 64 KiB chunk + the lib's adaptive prefetcher are
# the real levers, not a smaller page.
```

**Two things that block the browser run** (both fixed in this harness, learn from them):

- `sql.js-httpvfs@0.8.x` ships a **webpack UMD bundle, not ESM**. A bare `import { createDbWorker }`
  fails with _"does not provide an export named 'createDbWorker'"_. `index.html` loads it as a classic
  `<script>` (which assigns `createDbWorker` to `window`) and `client.mjs` reads it off `window`.
- Its bundled SQLite WASM has **no rtree module** (`no such module: rtree`), so `place_bbox` R\*Tree
  queries error. FTS5 + plain-column queries are fine. The browser resolver avoids R\*Tree for this reason.

**What the spike does NOT measure**:

- Cross-CDN latency (we serve locally; real production would be on Cloudflare/S3)
- WebGPU vs WASM SIMD for ONNX inference (separate spike if/when we get there)
- Memory consumption under sustained load
