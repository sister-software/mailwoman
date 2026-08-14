/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/libpostal` — a libpostal-compatible parse/expand HTTP API over Mailwoman's neural
 *   address parser. The lowest-dependency drop-in: `/parse` is a serializer over the BIO tagger's
 *   labeled spans, no gazetteer or resolver needed.
 *
 *   Engine-agnostic, like the nominatim/photon packages: {@link createLibpostalApp} takes a
 *   {@link LibpostalEngine}; the CLI wires the real parser. The classification → libpostal-label
 *   mapping lives in engine.ts (it is libpostal-specific knowledge), so the engine yields raw
 *   Mailwoman matches.
 */

export * from "./app.ts"
export * from "./engine.ts"
export * from "./schema.ts"
