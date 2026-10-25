# @mailwoman/api-worker

This private workspace holds the Hono entry point for hosted native geocoding. It forwards `POST /v1/parse` and
`POST /v1/geocode` to a private backend, and `GET /health` reports whether that backend answers. The backend
validates requests and emits the existing `@mailwoman/api` responses. Other API routes, including `/v1/reload`,
answer 404.

The Worker selects its backend from the environment. An `API_BACKEND` service binding takes precedence. Otherwise
`ENGINE_ORIGIN` names the HTTP origin of a `mailwoman serve` host. Without either, every request answers 503.

The Worker caps each request body at 64 KiB and answers 504 when the backend passes a 10-second deadline. It
replaces the backend's CORS headers with its own origin list: the Earth and docs origins, `dev.mailwoman.ai`, and
localhost.

## Run it locally

1. Start the engine: `node packages/mailwoman/out/cli/main.js serve --port 3917 --host 127.0.0.1 --cpus 1`.
2. Start the Worker from this directory: `yarn wrangler dev --port 8797 --var ENGINE_ORIGIN:http://127.0.0.1:3917`.
3. Open Earth with `?geocoder-api=http://127.0.0.1:8797/`. Earth then sends each address to the Worker and
   downloads no model, FST or gazetteer database.

`wrangler.toml` disables the public `workers.dev` route. The Worker has no production route and no deploy target.
Rate limits, telemetry, and the engine's production placement are open items in
`docs/superpowers/plans/2026-10-24-geocoder-worker.md`.
