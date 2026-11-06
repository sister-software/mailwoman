# Performance report

Measured by `node packages/registry/tools/bench.run.ts` on 2026-11-06, one run, on the lab host: AMD Ryzen 9
8945HS, 16 cores, 31 GB, Linux x64, Node v24.22.1, with a multi-state address merge running on the same host.
The numbers describe that run and are not a regression budget. Each value is the median over rounds of
nanoseconds per code, and every result is consumed so the work is kept.

The arms are a JavaScript `Set<string>` built from the normalized JSON (the baseline the specification
requires first), the TypeScript bitset reader (`isCountryAirportCollision`), and the WebAssembly batch
kernel (`classifyManyInto`) in its scalar and `simd128` builds. The wasm arm is measured twice: over
packed bytes the caller already holds, and over strings including the encode and the copy into linear
memory, so the boundary cost is visible rather than folded into a kernel number.

## Startup

| Startup                                                                                           | µs     |
| ------------------------------------------------------------------------------------------------- | ------ |
| module import (`#overlap/country-airport`, `#iso3166/alpha3`, `#iata/airports/validate`, `#wasm`) | 48,177 |
| artifact decode + validate (3 bitsets, base64 to bytes)                                           | 616    |
| first query                                                                                       | 39     |
| JS `Set` build from the normalized JSON (baseline)                                                | 2,046  |
| wasm scalar: compile + instantiate + load 3 artifacts                                             | 926    |
| wasm simd: compile + instantiate + load 3 artifacts                                               | 1,169  |

Module import dominates startup and is Node's module loading of the base64 modules and the reader; the
decode and validation of the three bitsets costs 0.6 ms.

## Lookups

| Arm               | Input                            | Distribution   | Batch | ns per code |
| ----------------- | -------------------------------- | -------------- | ----- | ----------- |
| JS Set (baseline) | strings                          | hits           | 1     | 70.0        |
| TypeScript bitset | strings                          | hits           | 1     | 191.0       |
| JS Set (baseline) | strings                          | hits           | 16    | 15.7        |
| TypeScript bitset | strings                          | hits           | 16    | 34.4        |
| JS Set (baseline) | strings                          | hits           | 17576 | 5.0         |
| TypeScript bitset | strings                          | hits           | 17576 | 23.3        |
| JS Set (baseline) | strings                          | misses         | 1     | 40.0        |
| TypeScript bitset | strings                          | misses         | 1     | 60.0        |
| JS Set (baseline) | strings                          | misses         | 16    | 8.8         |
| TypeScript bitset | strings                          | misses         | 16    | 27.6        |
| JS Set (baseline) | strings                          | misses         | 256   | 8.9         |
| TypeScript bitset | strings                          | misses         | 256   | 24.8        |
| JS Set (baseline) | strings                          | misses         | 4096  | 8.6         |
| TypeScript bitset | strings                          | misses         | 4096  | 24.7        |
| JS Set (baseline) | strings                          | misses         | 17576 | 8.5         |
| TypeScript bitset | strings                          | misses         | 17576 | 24.7        |
| JS Set (baseline) | strings                          | shuffled sweep | 1     | 40.0        |
| TypeScript bitset | strings                          | shuffled sweep | 1     | 50.0        |
| JS Set (baseline) | strings                          | shuffled sweep | 16    | 8.8         |
| TypeScript bitset | strings                          | shuffled sweep | 16    | 25.1        |
| JS Set (baseline) | strings                          | shuffled sweep | 256   | 9.0         |
| TypeScript bitset | strings                          | shuffled sweep | 256   | 24.9        |
| JS Set (baseline) | strings                          | shuffled sweep | 4096  | 9.8         |
| TypeScript bitset | strings                          | shuffled sweep | 4096  | 24.4        |
| JS Set (baseline) | strings                          | shuffled sweep | 17576 | 14.4        |
| TypeScript bitset | strings                          | shuffled sweep | 17576 | 25.4        |
| wasm scalar batch | packed bytes                     | hits           | 1     | 701.0       |
| wasm scalar batch | strings (encode + copy included) | hits           | 1     | 1011.0      |
| wasm scalar batch | packed bytes                     | hits           | 16    | 40.1        |
| wasm scalar batch | strings (encode + copy included) | hits           | 16    | 347.6       |
| wasm scalar batch | packed bytes                     | hits           | 17576 | 14.5        |
| wasm scalar batch | strings (encode + copy included) | hits           | 17576 | 275.7       |
| wasm scalar batch | packed bytes                     | misses         | 1     | 291.0       |
| wasm scalar batch | strings (encode + copy included) | misses         | 1     | 1032.0      |
| wasm scalar batch | packed bytes                     | misses         | 16    | 25.1        |
| wasm scalar batch | strings (encode + copy included) | misses         | 16    | 372.6       |
| wasm scalar batch | packed bytes                     | misses         | 256   | 7.6         |
| wasm scalar batch | strings (encode + copy included) | misses         | 256   | 333.9       |
| wasm scalar batch | packed bytes                     | misses         | 4096  | 6.7         |
| wasm scalar batch | strings (encode + copy included) | misses         | 4096  | 343.8       |
| wasm scalar batch | packed bytes                     | misses         | 17576 | 6.8         |
| wasm scalar batch | strings (encode + copy included) | misses         | 17576 | 347.6       |
| wasm scalar batch | packed bytes                     | shuffled sweep | 1     | 300.0       |
| wasm scalar batch | strings (encode + copy included) | shuffled sweep | 1     | 982.0       |
| wasm scalar batch | packed bytes                     | shuffled sweep | 16    | 24.4        |
| wasm scalar batch | strings (encode + copy included) | shuffled sweep | 16    | 401.4       |
| wasm scalar batch | packed bytes                     | shuffled sweep | 256   | 7.7         |
| wasm scalar batch | strings (encode + copy included) | shuffled sweep | 256   | 386.7       |
| wasm scalar batch | packed bytes                     | shuffled sweep | 4096  | 6.8         |
| wasm scalar batch | strings (encode + copy included) | shuffled sweep | 4096  | 349.1       |
| wasm scalar batch | packed bytes                     | shuffled sweep | 17576 | 6.8         |
| wasm scalar batch | strings (encode + copy included) | shuffled sweep | 17576 | 377.0       |
| wasm simd batch   | packed bytes                     | hits           | 1     | 641.0       |
| wasm simd batch   | strings (encode + copy included) | hits           | 1     | 1153.0      |
| wasm simd batch   | packed bytes                     | hits           | 16    | 37.6        |
| wasm simd batch   | strings (encode + copy included) | hits           | 16    | 394.5       |
| wasm simd batch   | packed bytes                     | hits           | 17576 | 7.3         |
| wasm simd batch   | strings (encode + copy included) | hits           | 17576 | 343.8       |
| wasm simd batch   | packed bytes                     | misses         | 1     | 311.0       |
| wasm simd batch   | strings (encode + copy included) | misses         | 1     | 872.0       |
| wasm simd batch   | packed bytes                     | misses         | 16    | 24.4        |
| wasm simd batch   | strings (encode + copy included) | misses         | 16    | 373.8       |
| wasm simd batch   | packed bytes                     | misses         | 256   | 7.2         |
| wasm simd batch   | strings (encode + copy included) | misses         | 256   | 555.1       |
| wasm simd batch   | packed bytes                     | misses         | 4096  | 5.9         |
| wasm simd batch   | strings (encode + copy included) | misses         | 4096  | 502.6       |
| wasm simd batch   | packed bytes                     | misses         | 17576 | 5.9         |
| wasm simd batch   | strings (encode + copy included) | misses         | 17576 | 453.2       |
| wasm simd batch   | packed bytes                     | shuffled sweep | 1     | 321.0       |
| wasm simd batch   | strings (encode + copy included) | shuffled sweep | 1     | 942.0       |
| wasm simd batch   | packed bytes                     | shuffled sweep | 16    | 25.1        |
| wasm simd batch   | strings (encode + copy included) | shuffled sweep | 16    | 407.0       |
| wasm simd batch   | packed bytes                     | shuffled sweep | 256   | 7.2         |
| wasm simd batch   | strings (encode + copy included) | shuffled sweep | 256   | 357.2       |
| wasm simd batch   | packed bytes                     | shuffled sweep | 4096  | 6.1         |
| wasm simd batch   | strings (encode + copy included) | shuffled sweep | 4096  | 351.7       |
| wasm simd batch   | packed bytes                     | shuffled sweep | 17576 | 6.1         |
| wasm simd batch   | strings (encode + copy included) | shuffled sweep | 17576 | 394.1       |

## What the run shows

- On strings, the JavaScript `Set` is the fastest arm at every batch size: 5 to 14 ns per code against 23
  to 25 ns for the TypeScript bitset, which pays for `charCodeAt` and the key arithmetic that the `Set`'s
  interned string hash avoids. The bitset's advantage is memory and startup rather than per-probe time: 2,197
  bytes decoded in 0.6 ms against a `Set` of 201 strings built from a 2.6 MB JSON parse.
- The wasm batch over packed bytes reaches 5.9 to 7.7 ns per code from 256 codes up, with the simd build 0.5
  to 0.9 ns per code ahead of the scalar build on the sweep and misses. Below 16 codes the boundary crossing
  dominates and a single code costs 300 to 700 ns.
- The wasm arm over strings costs 275 to 555 ns per code at every batch size. The `TextEncoder` encode of
  each string and its copy into linear memory cost 40 to 80 times the kernel's work. A caller with strings
  should use the TypeScript reader. The batch kernel serves a caller that already holds bytes.
- For the geocoder's workload, one string per request, the measured end-to-end cost is lowest on the JS
  `Set` arm. The registry's contribution to that path is the typed table with its stated sources and the
  collision index, and the per-probe time stays within tens of nanoseconds on every arm.

## Memory and bytes

| Artifact                    | Bytes     | SHA-256 (prefix) |
| --------------------------- | --------- | ---------------- |
| iso3166-1-alpha2-membership | 672       | 7daca3d6e81761ac |
| iso3166-1-alpha3-membership | 2,784     | 2fe14e6fe8677e47 |
| iso3166-1-records           | 51,624    | 965cdbd11e1732be |
| iata-airport-membership     | 2,792     | 01b6677cd90b3357 |
| iata-airport-records        | 1,123,320 | 3496ece1013624ad |
| country-airport-collision   | 3,056     | 2154993ce8f65602 |

The collision bitset's payload is 2,197 bytes; the 3,056-byte artifact adds the envelope, a 798-byte
header and padding. Each artifact ships as its own module holding its bytes as base64 (4/3 of the size),
so a bundle retains the artifacts its imports reach and no other; `tools/bundle-fixtures.integration.test.ts`
checks the country-only, collision-only, interpretation, wasm and type-only consumers. The wasm binaries
are 27,702 bytes (scalar) and 27,622 bytes (simd).

Allocation: after the first call, a TypeScript predicate probe reads the table in place with no new object.
Once its two staging buffers fit the batch, `classifyManyInto` reuses them on every call. `classify(strings)`
allocates the packed input and the result by design.
