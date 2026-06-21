# Client-side geocoder demo — architecture spec (#377)

_2026-06-14. The marquee: flesh the demo into a Google-Maps-style geocoder that runs **fully in the
browser** — type an address, get a map pin with a calibrated radius and the resolved hierarchy, with
no server round-trip. This spec resolves the architecture (the hard parts are the sync/async worker
boundary and the byte-range data layer), records the measurement that de-risks it, and lays out the
implementation in executable steps. Written headless during the 2026-06-14 night shift; the build
itself needs a browser (Playwright via `run-docs`) + R2 hosting, so it is scoped as the next session's
work, de-risked and specified here._

## The claim, and why it's now de-risked

The demo already byte-ranges the WOF resolver DB (`docs/src/shared/httpvfs-resolver.ts`,
sql.js-httpvfs, ~3.6 MB/session out of 53 MB). The open question for street-level geocoding was whether
the same trick survives a **3.3 GB** situs shard (California, 13.5 M points) — or whether a lookup
drags the whole file.

**Measured (`/tmp/situs-byterange-probe.mjs`, CA shard):** the geocode lookup is a clean indexed point
query —

```
SEARCH address_point USING INDEX idx_ap_postcode (postcode=? AND street_norm=? AND number=?)
```

The index B-tree is depth 4, so a lookup descends ~6 pages ≈ **24 KB**, out of 3.3 GB (0.0007%). The
total file size is irrelevant to lookup cost — that is the entire point of byte-range over an indexed
SQLite. **If CA works, every state works**, exactly as the plan predicted. A full geocode fires a few
such lookups (situs by postcode, situs by locality fallback, interp), so the data-fetch cost is a
handful of round-trips ≈ low-hundreds of KB, RTT-bound (~350 ms/query same-region from the spike), not
byte-bound.

### One data-layer tuning note

The situs shards are `page_size` 4096; the existing httpvfs resolver fetches in 64 KB `requestChunkSize`
chunks (16 pages). A situs point lookup touches ~6 _scattered_ B-tree pages, so it lands in a few
64 KB chunks — this is precisely the "sparse single-row access over-fetches" tradeoff the
`httpvfs-resolver.ts` header already calls out for the polygon DB. Two levers for the hosted demo
shards, to measure (not assume):

- **Rebuild hosted shards at a larger `page_size`** (32–64 KB) so a B-tree level is one chunk → fewer
  round-trips per lookup.
- **Tune `requestChunkSize` down** for the situs DB specifically (sparse access) vs up for the FTS-walk
  WOF DB — they want opposite chunk sizes.

## The architecture: extend the demo's existing async cascade (corrected)

A first reading of `geocode-core.ts` suggests a hard constraint: `geocodeAddress()` resolves via
`resolver.resolveTree(tree, { addressPoints, interpolation })`, and the resolver calls the lookups'
**synchronous** `find()` (`AddressPointLookup.find(): AddressPointHit | null` — sync by contract). That
would force "run the whole cascade inside a worker against synchronous sql.js handles," because
sql.js-httpvfs's fetches are sync XHR only _inside_ the worker.

**But the demo does not use `geocodeAddress`/`resolveTree`.** It has its own **async** cascade —
`runCascade()` in `docs/src/shared/demo-helpers.ts` — that already `await`s `lookup.findPlace(...)` over
the Comlink-proxied httpvfs worker on the main thread. So the street tiers slot in as **async** lookups
(mirroring the existing `WofHttpvfsPlaceLookup`), with no sync-interface problem and no
worker-internal-sync requirement. The sync `AddressPointLookup` contract is a _node_ concern (the CLI /
server path); the browser has always resolved async.

```
 main thread (extends the existing demo cascade)
 ──────────────────────────────────────────────
 onnxruntime-web parse → ParsedNodes
 street + number + (postcode|locality) present?
   ├─ await HttpvfsAddressPointLookup.find(...)   situs-<state>.db   → address_point tier
   ├─ else await HttpvfsInterpolator.find(...)    interp-<state>.db  → interpolated tier
   └─ else runCascade(...) (existing)             wof-hot.db         → admin tier
 → coordinate + tier + calibrated uncertainty_m → map pin + radius
```

The situs/interp handles are sql.js-httpvfs workers (one per loaded state, lazy by parsed region),
exactly like the WOF one the demo already opens.

### Is a Web Worker still wanted? Yes — but as an enhancement, not a necessity

The cascade is heavy (ONNX + several sync-XHR byte-range walks); on a cold cache it can block the main
thread long enough to jank the typeahead and the map. So **moving the whole cascade into a Web Worker
is still the right call** for UI responsiveness — but it is now an _optimization_ layered on a correct
async main-thread implementation, not the thing that makes correctness possible. Build the async street
tier first (it works on the main thread, like today's WOF resolve), then lift it into a worker. If/when
lifted, the page↔worker contract is:

```ts
// page → worker
{ type: "geocode", id: number, input: string, opts?: { defaultCountry?: string } }
// worker → page
{ type: "result", id: number, result: GeocodeResult, timing: { parse, resolve, situs, interp, total } }
{ type: "error",  id: number, message: string }
{ type: "progress", id: number, bytesRead: number }   // live transfer readout, like the WOF demo
```

`GeocodeResult` mirrors the existing `geocode-core.ts` type — coordinate, `tier`
(`address_point > interpolated > admin`), `uncertainty_m` (calibrated), resolved hierarchy.

### Latency budget + graceful degradation (per the DeepSeek review)

- **Budget: a geocode returns in < 3 s** (parse + resolve + situs + interp). Beyond that the user reads
  it as broken.
- **Per-tier timeout with admin-centroid fallback.** If the situs/interp byte-range walk stalls (cold
  cache, slow link), abandon the street tier and return the admin-centroid result the WOF resolve
  already produced — a coarse pin beats a spinner. The tier field tells the UI to widen the radius and
  caption it plainly. The cascade already degrades tier-by-tier; the worker adds the wall-clock guard.
- **Warm-up on idle**, mirroring `WofHttpvfsPlaceLookup.warmUp()` — pull the situs index root + the
  hot WOF pages during browser idle so the first submit isn't paying cold serial RTTs.

### Service Worker (build on `2026-06-06-demo-service-worker-design.mdx`)

Cache the immutable assets (sql.js-httpvfs UMD + worker + WASM, the ONNX model, the tokenizer) and the
byte-range responses (range requests are cacheable; a region's hot index pages stay warm across
queries → near-instant repeat lookups + offline resilience once warm). **Cap the cache** — the CA
shard's range responses could accumulate; an LRU eviction with a size ceiling (e.g. 50 MB of range
chunks) keeps it under storage quota. Indiscriminate caching of a 3.3 GB shard's pages is the failure
mode to avoid.

## Launch shards: NY / MI / CA

A deliberate size spread to validate byte-range latency across scales, hosted on R2 with Range support
and immutable `Cache-Control`:

| state | situs rows | situs size | role                                         |
| ----- | ---------: | ---------: | -------------------------------------------- |
| MI    |      858 K |     229 MB | mid-size baseline                            |
| NY    |      6.5 M |    1.44 GB | dense urban (NYC)                            |
| CA    |     13.5 M |    3.30 GB | the stress test — if it's OK, every state is |

State routing: `regionSlugFromTree()` (already in `geocode-core.ts`) picks the shard from the parsed
region; the worker lazy-loads that state's situs+interp handles on first use and caches them. The
demo's region constraint already biases the WOF resolve; the same slug selects the street shards.

## The autocomplete nuance (per the DeepSeek hint)

The shipped `mailwoman autocomplete` (#547) walks the **WOF FST** → it suggests _places_ (localities,
counties: "San Diego", "San Juan"), ranked by importance. That is the right typeahead for the
_locality_ field, but a Google-Maps-grade box also wants **address-level** suggestions ("350 5th Ave"
→ "350 5th Avenue, New York, NY"). Those are a different index — street-name prefixes over the situs
shards, not the admin FST. Three honest options, in increasing cost:

1. **Place-level typeahead only** (ship now): wire the existing FST autocomplete into the search box.
   Suggests cities/regions; the user types the full street themselves. Lowest cost, real value.
2. **Street-name autocomplete** within a resolved locality: once the user has a city, prefix-complete
   street names from that state's situs shard (`street_norm` has a natural prefix index). Mid cost.
3. **Full address autocomplete** (true Google-Maps): house-number + street + city as one suggestion
   stream. Highest cost; needs a dedicated suggestion index and ranking. A later milestone.

Recommend shipping (1) with the demo, designing the box so (2) slots in. Flagging (3) as its own
epic — it is more than "wire the existing feature," which is the nuance worth naming up front.

## Implementation steps

1. **`HttpvfsAddressPointLookup` + `HttpvfsInterpolator`** in `docs/src/shared/` — **async** `find()`
   over a sql.js-httpvfs handle (`worker.db.exec` + inline SQL), mirroring `AddressPointSqliteLookup` /
   the interpolation lookup query-for-query (same `street-normalize`, same postcode-then-locality
   scoping) and the existing `WofHttpvfsPlaceLookup` async idiom.
2. **A `resolveStreet()` street tier** in `demo-helpers.ts` — given the parsed street/number/postcode/
   locality + the two lookups, return `{ lat, lon, tier, uncertaintyM }` (situs → interp → null), so
   `index.tsx` runs it before `runCascade` and falls back to admin on a null. Main-thread async — no
   worker needed for correctness.
3. **Host MI first** (229 MB — smallest) byte-range; wire the street tier on Michigan end-to-end; verify
   via `run-docs` that the browser issues **Range** requests (pulls ~KB, not the full shard) on a real
   geocode. The gate — confirm before NY/CA. (Local Range-serving for the verification; R2 for prod.)
4. **Add NY, then CA**; measure CA's real in-browser geocode latency against the < 3 s budget.
5. **UX (#377):** map pin + calibrated-radius circle (the per-region factor from
   `data/calibration/interp-radius-conformal.json`) + tier caption; span-highlight by tag; resolved-
   hierarchy tree; per-stage timing; place-level autocomplete typeahead (option 1).
6. **Lift the cascade into a Web Worker** (UI responsiveness) + a **Service Worker** with the capped
   cache. Both are enhancements over the working main-thread version, not prerequisites.

## What's done headless vs. what needs a browser

Steps 1–2 are pure code mirroring an existing, tested pattern — written + query-verified against a real
shard with `node:sqlite` (the httpvfs version runs the identical SQL). Steps 3+ change browser code
whose correctness is only observable in a browser (Range requests fired, WASM loaded, map render) and
need shards served with byte-range. The two architectural risks — does byte-range survive the 3.3 GB
stress shard, and does the sync `find()` contract force a worker — are **both retired here** (it does;
it doesn't, because the demo's cascade is already async). So the remaining work is execution against a
de-risked spec, not open questions.

## Sources

- `/tmp/situs-byterange-probe.mjs` — the CA byte-range measurement (reproduce: `node … <shard>.db`)
- `docs/src/shared/httpvfs-resolver.ts` — the proven WOF byte-range pattern this extends
- `docs/articles/evals/2026-06-06-demo-service-worker-design.mdx` — the SW design to build on
- `mailwoman/geocode-core.ts` — `geocodeAddress`, `regionSlugFromTree`, `GeocodeResult`
- `core/resolver/types.ts` — the sync `AddressPointLookup` / `InterpolationLookup` contracts
- DeepSeek project review, 2026-06-14 (latency budget, SW cap, autocomplete depth)
