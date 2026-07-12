/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/api` — the native Mailwoman HTTP API: an engine-agnostic `/v1` surface (parse,
 *   geocode, batch, resolve, format) alongside health, metrics, and an emitted OpenAPI document.
 *   Unlike its drop-in siblings (`@mailwoman/nominatim`, `@mailwoman/photon`,
 *   `@mailwoman/libpostal`), nothing here mimics a third-party API — this is Mailwoman's own wire
 *   contract, so schemas are strict and validator-enforced rather than tolerant of legacy quirks.
 *
 *   Like its siblings, the package is engine-agnostic: routes take a {@link MailwomanAPIEngine}; the
 *   `mailwoman` CLI wires the real parse/geocode/resolve stack (phase 4b). The Hono app (CORS +
 *   body-size guard + the strict-validation error envelope + the emitted OpenAPI document) lives in
 *   `app.ts`; route definitions + handlers (incl. `registerMailwomanAPIRoutes`) in `routes.ts`; the
 *   engine contract in `engine.ts`; the zod wire schemas in `schema.ts`.
 */

export * from "./app.ts"
export * from "./engine.ts"
export * from "./routes.ts"
export * from "./schema.ts"
