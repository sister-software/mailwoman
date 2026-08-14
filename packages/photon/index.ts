/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/photon` — a Photon-compatible autocomplete / type-ahead geocoding API over the
 *   Mailwoman engine. Where `@mailwoman/nominatim` is structured lookup, Photon is
 *   search-as-you-type: a GeoJSON `FeatureCollection` per query, biased by location, ranked for
 *   prefixes. It maps onto Mailwoman's shipped FST autocomplete tier (#190/#587) + parse →
 *   resolve.
 *
 *   Like its siblings, the package is engine-agnostic: {@link createPhotonApp} takes a
 *   {@link PhotonEngine}; the CLI wires the real engine. Implementation is staged on the epic (#801
 *   / the Photon child); routes whose engine method is absent answer `501`.
 *
 *   The Hono app (CORS + error envelope + the emitted OpenAPI document) lives in `app.ts`; route
 *   definitions + handlers in `routes.ts`; wire types + the engine contract in `engine.ts`; the
 *   resolved-place → Photon-schema projection in `projection.ts`; the zod wire schemas in
 *   `schema.ts`.
 */

export * from "./app.ts"
export * from "./engine.ts"
export * from "./projection.ts"
export * from "./schema.ts"
