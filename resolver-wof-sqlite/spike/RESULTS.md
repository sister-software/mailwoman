# sql.js-httpvfs spike — results

**DB**: `/tmp/wof-httpvfs.db` (143 MB)

**Wall clock** (page load → all queries done): 857 ms

**Worker bootstrap** (sqlite-wasm ready): 188 ms

**Total DB fetches**: 38 range requests, 3648 KB total

**Asset bytes** (worker JS + WASM): 1305 KB


## Per-query latency

| Query | ms | rows | error |
|---|---:|---:|---|
| exact: New York | 54 | 9 | — |
| exact: Springfield | 25 | 10 | — |
| prefix: 902* | 7 | 10 | — |
| ranked: New York by population | 6 | 9 | — |
| bbox: Illinois bounding box | 1 | 0 | SQLite: no such module: rtree |
| proximity: near Springfield IL | 0 | 0 | SQLite: no such module: rtree |
| warm: New York repeat | 1 | 9 | — |
| warm: Springfield repeat | 1 | 10 | — |
