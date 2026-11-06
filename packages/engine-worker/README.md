# @mailwoman/engine-worker

This private workspace holds the Cloudflare Worker that answers `POST /v1/parse` and `POST /v1/geocode` for the
hosted geocoder. The API Worker binds it as `API_BACKEND`, so admission, CORS and the rate limiter stay in the API
Worker. Every gazetteer lookup goes to `@mailwoman/gazetteer-worker` over the `GAZETTEER` binding, because the
classifier and the gazetteer together exceed the 128 MB Worker memory limit. #2839 records the measurements, and
#2932 tracks the split.

## What it runs

The first request in an isolate loads the `en-us` releases manifest's default release through
`mailwoman/browser-runtime`, the loader Earth uses: the classifier, the FST prior, the street-morphology matcher, the
pair indexes and the anchor regions. The loader skips the gazetteer database.

- `/v1/parse` runs `runClassifyStage`, the stage Earth's local mode runs, so the request's `input_mode` has no effect.
- `/v1/geocode` resolves the parsed tree through the gazetteer cascade and projects it with the serve engine's
  `extractGeocodeResult`. Answers stop at the admin tier, because the street tiers' databases are not reachable from
  the Worker.

workerd refuses to compile WebAssembly from bytes. Wrangler bundles the tokenizer's `mtf.wasm` and onnxruntime's
`ort-wasm-simd-threaded.wasm` as compiled modules, and `lib/bundled-wasm.ts` hands them to the two runtimes.

## Run the three Workers together

From this directory:

```sh
yarn wrangler dev -c ../api-worker/wrangler.local-engine.toml -c wrangler.toml -c ../gazetteer-worker/wrangler.toml
```

Under `wrangler dev` the gazetteer Worker reads `candidate.db` from a local R2 store, and that store starts empty. The public file is 2.88 GB, so
seed the store with a small database for local work:

```sh
yarn wrangler r2 object put mailwoman-public/mailwoman/gazetteer/<version>/candidate.db --local --file <fixture.db> \
  -c ../gazetteer-worker/wrangler.toml
```

## Run the tests

`lib/engine.test.ts` runs in the root fast suite with a fake pipeline and a fake lookup.

```sh
yarn vitest run packages/engine-worker
```
