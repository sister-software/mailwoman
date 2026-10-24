# @mailwoman/api-worker

This private workspace holds the Hono entry point for hosted native geocoding. It forwards `POST /v1/parse` and
`POST /v1/geocode` to an injected private backend, and `GET /health` reports whether that backend answers. The
backend validates requests and emits the existing `@mailwoman/api` responses. Other API routes are unavailable.

The package is a scaffold. `wrangler.toml` names its entry point and disables the public `workers.dev` route.
It has no production route, backend binding, or deploy target. CORS, rate limits, telemetry, and engine placement
must be decided and verified before deployment. The initial HTTP boundary caps each request body at 64 KiB.
The implementation steps and acceptance criteria are in
`docs/superpowers/plans/2026-10-24-geocoder-worker.md`.
