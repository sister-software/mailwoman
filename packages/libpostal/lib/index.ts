/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Libpostal-compatible parse/expand HTTP API over Mailwoman's parser. The `/parse` endpoint serializes labeled spans
 *   without a gazetteer or resolver. The app accepts an injected engine; libpostal label mapping lives in `engine.ts`.
 */

export * from "#app"
export * from "#engine"
export * from "#schema"
