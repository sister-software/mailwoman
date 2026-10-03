---
title: "#2428 — the sqlite-wasm range reader on five databases, and the interpolation table layout"
description: Requests and bytes for the shipped browser lookups under sql.js-httpvfs and the sqlite-wasm range reader, and for the street_segment table before and after its rows are loaded in street order.
---

# #2428 — the sqlite-wasm range reader on five databases, and the interpolation table layout

## Conditions

- Browser: headless Chromium 153 under Playwright 1.63.0, one fresh context per measurement.
- Server: a local Node range server that adds 50 ms to each data request and sends `Cache-Control: no-store`.
  The server's own counters are the request and byte measurements.
- Each measurement opens one database cold and calls one shipped lookup from
  `packages/resolver-wof-wasm/lib/httpvfs/`.
- The old reader is `sql.js-httpvfs` 0.8.12 at a 64 KiB chunk. It ran the same statements with the
  parameters written into the SQL text.
- The new reader is `openRangeDatabase` at its default 64 KiB chunk.
- Each configuration ran once.

## Reader comparison

The databases are local copies: `candidate-2026-08-25b.db`, `address-points-us-ca.db`,
`interpolation-us-ca.db` (built 2026-06-14), `wof-polygons.db` and `poi.db`.

| Lookup                                   | Old reader, requests | New reader, requests | Old reader, bytes | New reader, bytes |
| ---------------------------------------- | -------------------: | -------------------: | ----------------: | ----------------: |
| candidate: `Springfield`, locality, US   |                    7 |                    6 |            512 KB |            384 KB |
| candidate: `Paris`                       |                    6 |                    5 |            384 KB |            320 KB |
| situs: `20990 Sherman Dr`, Castro Valley |                    8 |                    7 |            448 KB |            448 KB |
| interpolation: `5321 Foothill`, 94601    |                   35 |                   34 |          2,368 KB |          2,176 KB |
| polygon: id 85945763                     |                    4 |                    3 |            192 KB |            192 KB |
| POI: cafes, San Francisco                |                    8 |                    9 |            768 KB |            576 KB |
| POI: cafes, rural Nevada, 6 rings        |                    7 |                    7 |            448 KB |            448 KB |

Both readers returned the same rows in every lookup. The old reader issues one more request at open
because it sends a `HEAD` before its first range.

The POI search issued 92 statements under the old one-statement-per-cell loop and 7 under the
one-statement-per-ring query, for the six-ring rural lookup. The request count is 7 in both cases because
the cells of a ring share B-tree pages.

## Interpolation table layout

A lookup on the old `street_segment` layout fetched each candidate row from a different part of the file.
The index held `(postcode, street_norm, min_hn)`, so SQLite read the table row to test `max_hn`, and the
rows were stored in insert order.

The new layout loads the rows sorted by `(street_norm, postcode, min_hn, max_hn)` and adds `max_hn` to both
indexes. The table stays a rowid table because 745 of the 2,450,944 California rows have a null postcode.

Both builds are full California extracts from the same TIGER 2023 edges. The counts are requests through
the new reader.

| Lookup                            | Old layout, requests | New layout, requests | Old layout, query time | New layout, query time |
| --------------------------------- | -------------------: | -------------------: | ---------------------: | ---------------------: |
| `5321 Foothill Blvd`, 94601       |                   43 |                    6 |               2,291 ms |                 273 ms |
| `5321 Foothill Blvd`, no postcode |                  249 |                    6 |              13,518 ms |                 277 ms |
| `6801 Hollywood Blvd`, 90028      |                   26 |                    6 |               1,369 ms |                 275 ms |
| `100 Main St`, no postcode        |                  192 |                   15 |              10,332 ms |                 774 ms |

Both layouts returned the same result for all four lookups. The file grew from 779,284,480 bytes to
794,361,856 bytes, which is 1.9%.

## Limits

- The Earth Playwright suite and the ported gazetteer probe in `browser-slo.integration.test.ts` did not
  complete on the development host. Every failure stopped at the model download, on this branch and
  against the deployed application.
- The published interpolation extracts keep the old layout until each state is rebuilt and uploaded.
