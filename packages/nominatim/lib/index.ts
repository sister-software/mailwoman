/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/nominatim`, a Nominatim-compatible http geocoding API over the Mailwoman engine.
 *
 *   The package is engine-agnostic: {@link createNominatimApp} takes a {@link NominatimEngine} and
 *   exposes it under the endpoint shapes and response format a Nominatim client expects. The CLI
 *   wires the real Mailwoman engine and tests can inject a fake, which keeps the compat surface
 *   isolated from the resolver wiring.
 *
 *   Routes whose engine method is absent answer `501`, with `/status` as the one exception.
 *
 *   The Hono app lives in `app.ts`, the route definitions and handlers in `routes.ts`, the wire
 *   types and engine interface in `engine.ts`, the resolved-address formatter in `format.ts`, and
 *   the zod wire schemas in `schema.ts`.
 */

export * from "#app"
export * from "#engine"
export * from "#format"
export * from "#routes"
export * from "#schema"
