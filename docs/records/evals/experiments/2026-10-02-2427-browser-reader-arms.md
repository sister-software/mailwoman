---
title: "#2427 — three browser readers on the candidate-table name probe"
description: Requests, bytes and latency for sql.js-httpvfs, an HTTP range VFS on @sqlite.org/sqlite-wasm, and DuckDB-Wasm over the same 16 name probes.
---

# #2427 — three browser readers on the candidate-table name probe

The Earth map search resolves a place name with one probe on the `candidate` table of `candidate.db`,
read over HTTP range requests by `sql.js-httpvfs` 0.8.12. This record measures that reader against two
replacements on the same probes.

## Result

Both SQLite readers return a cold probe in 3 to 5 range requests. Replacing `sql.js-httpvfs` with a range
VFS on `@sqlite.org/sqlite-wasm` changes the SQLite version from 3.35.0 to 3.53.4. At the current 64 KiB chunk it issued 55 requests
against 52, fetched 3,520 KB against 4,224 KB, and returned the median cold probe in 167 ms against
168 ms. DuckDB-Wasm over Parquet
fetched 37 times the bytes of the current reader on the cold pass and ran a warm probe in 47.5 ms
against 0.7 ms.

## Conditions

- Database: `candidate-2026-08-25b.db`, 2,880,921,600 bytes, page size 8192, 15,183,707 `candidate` rows.
- Parquet: the `candidate` table sorted by `name_key, neg_rank`, zstd, at row-group sizes 122,880
  (617,457,833 bytes) and 8,192 (689,133,020 bytes).
- Probe: the 14 columns `WOFCandidateTableLookup.findPlace` selects, `WHERE name_key = ?`,
  `ORDER BY neg_rank, spr_id LIMIT 64`.
- Probe keys, in order: `springfield`, `chicago`, `berlin`, `london`, `paris`, `san jose`, `saint-etienne`,
  `北京`, `東京`, `new york`, `portland`, `sheldon`, `sao paulo`, `washington`, `munchen`, `zzzz absent`.
- Browser: headless Chromium 153 under Playwright 1.63.0, one fresh context per arm.
- Server: a local Node range server on `127.0.0.1` that sends `Cache-Control: no-store`. The server's
  own counters are the request and byte measurements for every arm.
- Each arm opens the reader, runs the 16 probes once (cold pass), then runs them again (warm pass).
- Every arm returned the same `spr_id` list for all 16 probes.
- Each configuration ran once per delay. The request and byte counts were identical across the two
  delays.

## Measurements

Requests and bytes are totals over the 16 cold probes. The warm pass issued zero requests in every arm.

| Arm                                      | Runtime download | Cold requests | Cold bytes | Open, 50 ms delay | Median cold probe, 50 ms delay | Median warm probe |
| ---------------------------------------- | ---------------: | ------------: | ---------: | ----------------: | -----------------------------: | ----------------: |
| `sql.js-httpvfs`, 64 KiB chunk (current) |         1,300 KB |            52 |   4,224 KB |            170 ms |                         168 ms |            0.7 ms |
| `sql.js-httpvfs`, 8 KiB chunk            |         1,300 KB |            63 |     776 KB |            171 ms |                         219 ms |            0.9 ms |
| sqlite-wasm range VFS, 64 KiB chunk      |         1,481 KB |            55 |   3,520 KB |            103 ms |                         167 ms |            1.4 ms |
| sqlite-wasm range VFS, 8 KiB chunk       |         1,481 KB |            84 |     672 KB |            102 ms |                         220 ms |            1.1 ms |
| DuckDB-Wasm, row group 122,880           |        36,484 KB |           150 | 156,372 KB |            865 ms |                         677 ms |           45.6 ms |
| DuckDB-Wasm, row group 8,192             |        36,484 KB |            80 |  23,531 KB |            738 ms |                         567 ms |          283.9 ms |

The 50 ms delay is added by the server to each data request and stands in for one network round trip.
With zero added delay the median cold probe was 7 to 15 ms for the four SQLite configurations, 96 ms for
DuckDB-Wasm at row group 122,880 and 294 ms at row group 8,192.

## Observations

**Chunk size trades bytes for round trips.** In `sql.js-httpvfs`, an 8 KiB chunk fetched 776 KB against
4,224 KB, which is 18% of the bytes. It issued 63 requests against 52, and the median cold probe at a
50 ms delay rose from 168 ms to 219 ms. Each request waits for the previous one, so the request count
sets the latency.

**The sqlite-wasm range VFS matches the current reader.** At a 64 KiB chunk it issued 55 requests against
52 and fetched 3,520 KB against 4,224 KB. Its open took one data request against two. The VFS in this
experiment has no read-ahead, which accounts for 84 requests against 63 at the 8 KiB chunk.

**DuckDB-Wasm reads megabytes per probe.** Its read-ahead grows from 16 KiB to 16 MiB within one probe.
The first probe, `springfield`, fetched 7,028 KB in 14 requests at row group 122,880, against 448 KB in 5
requests for the current reader. A warm probe decodes a whole row group, which is the 45.6 ms and
283.9 ms in the last column.

**DuckDB-Wasm 1.33.1-dev57.0 needs explicit configuration to issue range requests.** With the default
filesystem configuration the first query fetched the whole Parquet file in one `GET`. Range reads began
after `registerFileURL` and `db.open` with `allowFullHTTPReads: false` and `reliableHeadRequests: true`.

**DuckDB-Wasm fetches its Parquet extension from a third-party host.** The page requested
`https://extensions.duckdb.org/v1.5.4/wasm_eh/parquet.duckdb_extension.wasm`. That download is outside
the 36,484 KB counted above.

## Limits

- The latencies come from a local server with a fixed delay. They rank the arms and do not predict a
  production figure.
- The harness is uncommitted. It consists of a range server, a Playwright driver and a 150-line read-only
  VFS built on `sqlite3.vfs.installVfs`.
- The POI, street and polygon databases are unmeasured.
