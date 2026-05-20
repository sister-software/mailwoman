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
npm install
node run.mjs --db /mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db
# → results.json + RESULTS.md in the same directory
```

**What the spike does NOT measure**:

- Cross-CDN latency (we serve locally; real production would be on Cloudflare/S3)
- WebGPU vs WASM SIMD for ONNX inference (separate spike if/when we get there)
- Memory consumption under sustained load
