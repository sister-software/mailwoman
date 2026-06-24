/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/resolver` — the address resolver implementation, lifted out of `@mailwoman/core`
 *   (#215) so it can depend on `@mailwoman/spatial` (haversine) + `@mailwoman/codex` (USPS
 *   directionals) instead of reinventing them. The TYPE contract stays in
 *   `@mailwoman/core/resolver` (so the `core/pipeline` composes the resolver structurally without a
 *   package cycle); this barrel re-exports it, so `@mailwoman/resolver` is a complete drop-in for
 *   what used to be `@mailwoman/core/resolver`.
 */

export { RemoteResolver, serializableResolveOpts } from "./remote-resolver.js"
export type {
	RemoteResolverOpts,
	ResolveTreeRequest,
	ResolveTreeResponse,
	SerializableResolveOpts,
} from "./remote-resolver.js"
export { createWofResolver } from "./resolve.js"
export { findRescoreCandidate, hasResolvedPlace } from "./span-rescore.js"
export type { RescoreCandidate, SpanRescoreOptions } from "./span-rescore.js"

// The type contract + placetype helpers live in core (pure types, keep core a leaf). Re-export so
// consumers get the whole surface from `@mailwoman/resolver`.
export * from "@mailwoman/core/resolver"
