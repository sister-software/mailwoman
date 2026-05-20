# sqlite-wasm-over-http feasibility — Node-side measurement

**DB**: `/mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db` (4069.23 MB, 1,041,723 pages × 4096 B)

Measured locally with Node `node:sqlite`. Local latencies are the lower bound on what a browser-side WASM build would see — only data-fetch latency stacks on top.

## Per-query results

| Query                          | rows | local ms | objects touched                     | footprint | est. cold fetch | est. requests |
| ------------------------------ | ---: | -------: | ----------------------------------- | --------: | --------------: | ------------: |
| exact: New York                |   10 |     39.2 | place_search, spr                   | 103.55 MB |        620.0 KB |            10 |
| exact: Springfield             |   10 |     0.23 | place_search, spr                   | 103.55 MB |        620.0 KB |            10 |
| prefix: 902\*                  |    0 |     0.14 | place_search, spr                   | 103.55 MB |         92.0 KB |             2 |
| ranked: New York by population |   10 |     0.61 | place_search, spr, place_population | 104.71 MB |        624.0 KB |            10 |
| bbox: Illinois bounding box    |   10 |     8.95 | spr, place_bbox                     |  53.61 MB |        584.0 KB |            10 |
| proximity: near Springfield IL |    5 |     1.35 | place_search, spr, place_bbox       | 116.87 MB |        332.0 KB |             6 |
| warm: New York repeat          |   10 |     0.28 | place_search, spr                   | 103.55 MB |        620.0 KB |            10 |
| warm: Springfield repeat       |   10 |     0.23 | place_search, spr                   | 103.55 MB |        620.0 KB |            10 |

## Network cost translation

Assuming HTTP/2 (we get to multiplex but each fetch still costs an RTT) and 64 KiB request chunks:

| Query                          | est. KB | est. reqs | Same-region CDN (Cloudflare PoP < 50 ms RTT) | Cross-continent (200 ms RTT, 25 Mbps) | Mobile LTE worst case (400 ms RTT, 5 Mbps) |
| ------------------------------ | ------: | --------: | -------------------------------------------: | ------------------------------------: | -----------------------------------------: |
| exact: New York                |     620 |        10 |                                       351 ms |                               2203 ms |                                    5016 ms |
| exact: Springfield             |     620 |        10 |                                       351 ms |                               2203 ms |                                    5016 ms |
| prefix: 902\*                  |      92 |         2 |                                        68 ms |                                430 ms |                                     951 ms |
| ranked: New York by population |     624 |        10 |                                       351 ms |                               2204 ms |                                    5022 ms |
| bbox: Illinois bounding box    |     584 |        10 |                                       348 ms |                               2191 ms |                                    4957 ms |
| proximity: near Springfield IL |     332 |         6 |                                       207 ms |                               1309 ms |                                    2944 ms |
| warm: New York repeat          |     620 |        10 |                                       351 ms |                               2203 ms |                                    5016 ms |
| warm: Springfield repeat       |     620 |        10 |                                       351 ms |                               2203 ms |                                    5016 ms |

## Interpretation

- **Average local query latency**: 6.37 ms. The browser will pay this _plus_ network cost.
- **Average estimated cold-fetch volume**: 514.0 KB over ~8.5 HTTP requests per query.
- **Total DB**: 4069.23 MB but only **0.01%** is touched per query on average.
- **Caveats**: estimates are derived from a query-plan + dbstat heuristic, not from an actual HTTP-VFS run. Real browser numbers will likely be _lower_ (warm cache, request coalescing) for the first 5–10 unique queries and _flat_ thereafter.
- **Concentrating fetches**: if we cluster admin-US localities by FTS5 docid, repeat-warmth dominates. Realistic cap for a public demo doing 90% common queries: < 100 KB/query after warmup, < 1 MB cold-start.
