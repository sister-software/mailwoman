/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/api-kit` — plumbing for Mailwoman's HTTP surfaces: the node serve wrapper, OpenAPI
 *   emit helpers, generic timing metrics, and the native error envelope. Plumbing only, by rule:
 *   domain schemas live next to their routes in the package that owns the wire contract (see the
 *   2026-07-12 design spec's anti-meta guardrails).
 */

export * from "./error.ts"
export * from "./geo.ts"
export * from "./metrics.ts"
export * from "./openapi.ts"
export * from "./serve.ts"
