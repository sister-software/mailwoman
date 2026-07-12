/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/nominatim` — a Nominatim-compatible HTTP geocoding API over the Mailwoman engine.
 *
 *   The package is intentionally engine-agnostic: {@link createNominatimApp} takes a
 *   {@link NominatimEngine} (the thing that actually parses + resolves) and exposes it under the
 *   endpoint shapes + response format a Nominatim client expects. The CLI (`./cli.ts`) wires the
 *   real Mailwoman engine; tests can inject a fake. This keeps the compat surface isolated from the
 *   resolver wiring.
 *
 *   Implementation is staged across the epic (#801): #804 the result formatter, #802 `/search`, #803
 *   `/reverse`, #805 `/lookup` + `/status`. Routes whose engine method is absent answer `501`
 *   (`/status` is the one exception — see `routes.ts`).
 *
 *   The Hono app (CORS + error envelope + the emitted OpenAPI document) lives in `app.ts`; route
 *   definitions + handlers (incl. `registerNominatimRoutes`, exported from the package root as the
 *   phase-4 `mailwoman serve` carry-forward) in `routes.ts`; wire types + the engine contract in
 *   `engine.ts`; the RESOLVED-address → Nominatim-schema formatter in `format.ts`; the zod wire
 *   schemas in `schema.ts`.
 */

export * from "./app.ts"
export * from "./engine.ts"
export * from "./format.ts"
export * from "./routes.ts"
export * from "./schema.ts"
