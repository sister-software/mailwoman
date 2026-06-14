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
chunks (16 pages). A situs point lookup touches ~6 *scattered* B-tree pages, so it lands in a few
64 KB chunks — this is precisely the "sparse single-row access over-fetches" tradeoff the
`httpvfs-resolver.ts` header already calls out for the polygon DB. Two levers for the hosted demo
shards, to measure (not assume):

- **Rebuild hosted shards at a larger `page_size`** (32–64 KB) so a B-tree level is one chunk → fewer
  round-trips per lookup.
- **Tune `requestChunkSize` down** for the situs DB specifically (sparse access) vs up for the FTS-walk
  WOF DB — they want opposite chunk sizes.

## The architecture: a single geocode worker (worker-internal-sync)

The non-obvious constraint. `geocodeAddress()` is `async`, but it resolves coordinates by calling
`resolver.resolveTree(tree, { addressPoints, interpolation })`, and the resolver calls the lookups'
**synchronous** `find()` (`AddressPointLookup.find(): AddressPointHit | null`,
`InterpolationLookup.find(): InterpolatedPointHit | null` — both sync by contract). So the lookups must
be synchronous *at the point the resolver runs them*.

sql.js-httpvfs makes this possible: **its byte-range fetches inside the worker are synchronous XHR** —
the async (Promise) only appears at the Comlink proxy *across* the main↔worker boundary. So the design
is **not** "make the lookups async and refactor the cascade" — it is "run the whole cascade inside the
worker, against synchronous sql.js handles." The page never sees a sync API; it posts a string and gets
a result.

```
 main thread                          geocode worker (owns everything sync)
 ───────────                          ─────────────────────────────────────
 input string ─ postMessage ────────▶ onnxruntime-web session (parse)
                                       sql.js-httpvfs sync handles:
                                         · wof-hot.db        (admin resolve)
                                         · situs-<state>.db  (exact point)   ← lazy, by parsed region
                                         · interp-<state>.db (HN interp)     ← lazy, by parsed region
                                       geocodeAddress(input, { classifier, resolver, shards })
 GeocodeResult ◀─ postMessage ───────  └─ unchanged: sync find() over sync handles
```

This is why the plan's "geocodeAddress runs unchanged once the browser supplies the three deps" is
*true* — but only inside the worker. The worker is not an optimization to bolt on later; it is the
thing that lets the sync interface stand. Design the page↔worker message as the contract from line one.

### Worker-message contract

```ts
// page → worker
{ type: "geocode", id: number, input: string, opts?: { defaultCountry?: string } }
// worker → page
{ type: "result", id: number, result: GeocodeResult, timing: { parse, resolve, situs, interp, total } }
{ type: "error",  id: number, message: string }
{ type: "progress", id: number, bytesRead: number }   // live transfer readout, like the WOF demo
```

`GeocodeResult` is the existing `geocode-core.ts` type — coordinate, `tier`
(`address_point > interpolated > admin`), `uncertainty_m` (calibrated), and the resolved hierarchy. No
new shape.

### Latency budget + graceful degradation (per the DeepSeek review)

- **Budget: a geocode returns in < 3 s** (parse + resolve + situs + interp). Beyond that the user reads
  it as broken.
- **Per-tier timeout with admin-centroid fallback.** If the situs/interp byte-range walk stalls (cold
  cache, slow link), abandon the street tier and return the admin-centroid result the WOF resolve
  already produced — a coarse pin beats a spinner. The tier field tells the UI to widen the radius and
  caption it honestly. The cascade already degrades tier-by-tier; the worker adds the wall-clock guard.
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

| state | situs rows | situs size | role                          |
| ----- | ---------: | ---------: | ----------------------------- |
| MI    |       858 K |     229 MB | mid-size baseline             |
| NY    |      6.5 M |    1.44 GB | dense urban (NYC)             |
| CA    |     13.5 M |    3.30 GB | the stress test — if it's OK, every state is |

State routing: `regionSlugFromTree()` (already in `geocode-core.ts`) picks the shard from the parsed
region; the worker lazy-loads that state's situs+interp handles on first use and caches them. The
demo's region constraint already biases the WOF resolve; the same slug selects the street shards.

## The autocomplete nuance (per the DeepSeek hint)

The shipped `mailwoman autocomplete` (#547) walks the **WOF FST** → it suggests *places* (localities,
counties: "San Diego", "San Juan"), ranked by importance. That is the right typeahead for the
*locality* field, but a Google-Maps-grade box also wants **address-level** suggestions ("350 5th Ave"
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

## Implementation steps (next session — needs a browser + R2)

1. **`HttpvfsAddressPointLookup` + `HttpvfsInterpolator`** in `docs/src/shared/` — sync `find()` over a
   sql.js-httpvfs handle, mirroring `AddressPointSqliteLookup` / the interpolation lookup query-for-query
   (same `street-normalize`, same postcode-then-locality scoping). They run *inside the worker*, so
   `find()` stays sync against the worker's sync handle.
2. **The geocode worker** — own the ONNX session (`onnxruntime-web/webgpu`, per the int8-on-Metal note)
   + the three sql.js handles; implement the message contract + the per-tier timeout + warm-up.
3. **Host MI first** (229 MB — smallest) on R2 byte-range; wire the worker end-to-end on Michigan;
   verify via `run-docs` that the browser issues **Range** requests (pulls ~KB, not the full shard) on
   a real geocode. This is the gate — confirm before NY/CA.
4. **Add NY, then CA**; measure CA's real in-browser geocode latency against the < 3 s budget.
5. **UX (#377):** map pin + calibrated-radius circle + tier caption; span-highlight by tag; resolved-
   hierarchy tree; per-stage timing; place-level autocomplete typeahead (option 1).
6. **Service Worker** with the capped cache.

## Why this is the headless deliverable, not the demo itself

Every step above changes browser code whose correctness is only observable in a browser (Range requests
fired, WASM loaded, worker messaging, map render) — and step 3+ needs the shards hosted on R2. Building
it blind and unverified would violate ship discipline. What *was* doable headless — proving the data
layer survives the 3.3 GB stress shard, and resolving the sync/async architecture that the sync `find()`
contract forces — is done here. The next session executes steps 1–6 against this spec with the
byte-range risk already retired.

## Sources

- `/tmp/situs-byterange-probe.mjs` — the CA byte-range measurement (reproduce: `node … <shard>.db`)
- `docs/src/shared/httpvfs-resolver.ts` — the proven WOF byte-range pattern this extends
- `docs/articles/evals/2026-06-06-demo-service-worker-design.mdx` — the SW design to build on
- `mailwoman/geocode-core.ts` — `geocodeAddress`, `regionSlugFromTree`, `GeocodeResult`
- `core/resolver/types.ts` — the sync `AddressPointLookup` / `InterpolationLookup` contracts
- DeepSeek project review, 2026-06-14 (latency budget, SW cap, autocomplete depth)
