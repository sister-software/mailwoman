# Hosted geocoder API Worker plan — 2026-10-24

## Current state and decision

**Observed:** Earth runs classification and resolution in the browser. Its live `en-us/releases.json` points to `v10.1.0`, with `splitEmbeddings: true` and `hasFST: true`. The October 8 cold-load trace, before the split release, measured 76,517,011 wire bytes across 65 requests. That trace measures the earlier release. Today's mobile load remains unmeasured. [Issue #2505](https://github.com/sister-software/mailwoman/issues/2505) and [PR #2506](https://github.com/sister-software/mailwoman/pull/2506) record the changes.

**Observed:** `@mailwoman/api` supplies Hono routes for `/v1/parse`, `/v1/geocode`, `/v1/batch`, `/v1/resolve`, `/v1/format`, health, metrics, and OpenAPI. `mailwoman serve` supplies the real engine from Node and local model and database files. The Photon and Nominatim packages supply separate compatibility routes. The Fastify package is an embedding adapter. Its reserved version does not supply the hosted engine.

**Observed:** Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) give each isolate 128 MB, including WebAssembly allocations. Its [WebAssembly documentation](https://developers.cloudflare.com/workers/runtime-apis/webassembly/) states that Workers do not support threading or Web Workers. [Containers](https://developers.cloudflare.com/containers/platform/limits/) offer larger memory and a full Linux runtime, at a separate running cost. None of these platform facts measures Mailwoman's model memory or throughput.

**Decided for this scaffold:** `@mailwoman/api-worker` is a private Hono HTTP entry point. Its backend is an injected Fetch interface. The first implementation forwards the native parse and geocode operations to an engine service and preserves the backend's status, body, and provenance fields. It does not load model weights, an FST, or SQLite in the Worker isolate. The Worker is not added to production deployment until the engine service and abuse controls are specified and tested.

**Unknown:** The memory and latency of the complete hosted engine under real concurrency, the Cloudflare deployment form for that engine, the current Earth mobile cold-load distribution, the hosting cost at expected request volume, and the policy for public anonymous traffic. Measurements below resolve these questions before a production decision.

## Target shape

```text
Earth browser ── HTTPS ──> api-worker (Hono: CORS, admission, routing, telemetry)
                                      │
                                      └── private engine service
                                          └── existing Mailwoman model, FST, gazetteer, and API engine
```

- The Worker accepts `POST /v1/parse` and `POST /v1/geocode` first. The backend validates the existing native request schemas and returns the existing native response schemas. The Worker does not invent a second JSON shape.
- The Worker owns a small readiness route. Its response distinguishes Worker availability from backend readiness. A backend timeout or unreadable response is an error with an identifiable status, never a valid-looking empty result.
- The Worker forwards only request headers the backend needs. It sets the backend address through a private binding. It does not expose `/v1/reload`, backend administration, or a generic forwarding path to public callers.
- The Worker preserves the engine stamp, `coordinate_source`, license header, and response status. The API's OpenAPI document remains generated from the native route table. If the Worker serves it, the document must describe only exposed routes and their authentication policy.
- The engine service may use the current Node `createServeEngine` and `createMailwomanAPI` stack. A Cloudflare Container is one candidate because it can run Node and the local data files. A separately hosted service is another. Select between them with the same load, cold-start, and cost measurements.
- Photon `/api` and Nominatim `/search` are later adapters over the hosted engine. Their route and projection packages may be reused after the native path works. They do not define Earth's first wire contract.

## Ordered work

1. **Record the baseline.** On a real mid-range mobile device and a throttled browser run, capture Earth navigation-to-interactive, first successful parse, first successful geocode, transferred bytes by asset, peak browser memory, and warm query latency. Record device, connection, cache state, release version, and at least 30 cold and 100 warm samples. Save the request trace and raw results. Run the same addresses through the current local runtime.
2. **Measure the engine.** Boot `createServeEngine` with the exact published model and data generation. Measure resident memory after boot, per-request peak memory, cold start, throughput, and p50/p95/p99 latency at concurrency 1, 4, and 16. Include model, FST, candidate database, and street tiers. Show separate results for parse-only and full geocode. Refuse a backend choice if the required data is absent.
3. **Choose the backend placement.** Try a direct Workers isolate only if its complete model and runtime fit below 128 MB with concurrent-request headroom and the route graph bundles under Worker conditions. Otherwise run the existing Node engine in a Cloudflare Container or another private service. Measure Container image startup, data staging, warm retention, placement, and monthly cost against the expected request denominator. Record the selected form and rejected alternatives with measurements.
4. **Complete the Worker transport.** Replace the scaffold's injected backend with the selected private binding. Add bounded request bodies, request deadlines, backend failure mapping, CORS for Earth, rate limits, and a policy for anonymous use. Keep secrets out of client responses and logs. Make malformed input and backend outages distinct.
5. **Prove native API parity.** Run the same addresses against `mailwoman serve` and the Worker path, comparing full response JSON, status, provenance, model version, and license headers. Include US, GB, FR, DE, JP, and address-point cases. Compare both successful and validation/error cases. Explain every difference before release.
6. **Add backend observability.** Record request counts, error counts by stage, CPU time, backend queue time, model time, resolver time, cold starts, memory, and response latency without logging raw addresses. Expose a readiness probe and a version receipt identifying the model, data generation, Worker commit, and backend build.
7. **Wire Earth as the first consumer.** Add a remote runtime adapter that implements the `GeocoderRuntime` methods Earth uses. Preserve the existing local runtime as an explicit fallback or selectable mode until the remote path meets the production switch requirements below. Keep map tile loading independent of geocoder readiness. Avoid fetching model, FST, and classifier wasm when remote mode is selected.
8. **Compare user-visible behavior.** Re-run the baseline device and network conditions against remote and local modes. Report transferred bytes, navigation-to-interactive, first result, warm latency, errors, and total request cost. For each differing address, show the exact input beside expected and observed results and name the first divergent stage.
9. **Deploy in stages.** Add `api-worker` to the deploy target registry only after its backend binding, rate limits, CORS, and version receipt are present. Deploy to a non-public preview, run smoke and load tests, then deploy the Worker and engine service. Switch Earth through a reversible runtime flag. Keep the local path available until the new path passes the release criteria and the rollback has been exercised.
10. **Extend the hosted surface.** Consider batch, resolve, Photon, and Nominatim after the native Earth path works. Each route needs its own cost limit, response parity checks, and abuse policy. Do not expose `/v1/reload` publicly.

## Production switch requirements

- The exact model and data versions served by the backend appear in the receipt and responses. A missing requested artifact causes a readiness failure.
- The Worker and backend return the native API's statuses, schemas, attribution, and engine stamp for the selected route set. The parity receipt names every address and comparison arm.
- Remote Earth omits model, FST, embedding, tokenizer, and classifier wasm downloads on a cold load. The browser trace proves this for the selected release.
- Mobile first-result and warm-result latency distributions are reported against the local baseline under identical conditions. Set numeric launch thresholds from the product latency budget before judging the result. Do not fit them to the current failures.
- The load run shows memory, throughput, failure rate, and cost at the expected peak concurrency. Rate limiting and backend failure tests pass.
- A rollback changes Earth to the local runtime without a Worker or backend redeploy. The same production smoke passes after rollback.

## Implementation path on 2026-10-24

The `packages/api-worker` Worker forwards `POST /v1/parse` and `POST /v1/geocode` to an `API_BACKEND` service binding or to the `mailwoman serve` origin in `ENGINE_ORIGIN`. It applies its own CORS origin list, a 64 KiB body cap, and a 10-second backend deadline that answers 504. It remains absent from `.github/workflows/deploy.yml` and the deploy target registry.

Earth selects the remote runtime when `?geocoder-api=<URL>` is present or when `EarthConfig.geocoderAPIURL` is set. `?geocoder=local` selects the browser runtime. `PRODUCTION_CONFIG.geocoderAPIURL` is `null`, so production behavior is unchanged. The remote runtime sends `/v1/parse` and `/v1/geocode` together. The geocode response supplies the coordinate and candidates. The parse response supplies the tree, span offsets, and confidences. The geocode response omits them. The engine therefore parses each address twice.

**Observed locally:** `mailwoman serve` (`neural-weights-en-us` 10.7.0, one worker, 313 MB resident after boot) behind `wrangler dev` answered `1600 Pennsylvania Ave NW, Washington, DC 20500` at the `address_point` tier (38.8977, -77.0365, 1 m) in 61 ms end to end. In a built Earth page with `?geocoder-api=`, the browser requested no `releases.json`, model, FST, or gazetteer database, and the map placed the rooftop pin.

The remote runtime omits these local-runtime features:

- Viewport and device-location bias, because `/v1/geocode` accepts no bias.
- FST autocomplete, because the API has no completion route.
- Crisp admin polygons, because they read the release's `wof-polygons.db`. Candidates render as points.
- Query kind, stage timing, dual roles, and the calibrator. The native responses contain none of them.
- Candidate scores. The native response orders candidates without scoring them, so a runner-up shows score 0.

The trace page still loads the classifier in the browser.
