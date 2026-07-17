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

export { RemoteResolver, serializableResolveOpts } from "./remote-resolver.ts"
export type {
	RemoteResolverOpts,
	ResolveTreeRequest,
	ResolveTreeResponse,
	SerializableResolveOpts,
} from "./remote-resolver.ts"
export { createWOFResolver } from "./resolve.ts"
export { finestResolvedCoordinate, isImplausibleResolution } from "./plausibility.ts"
export type { PlausibilityVerdict, ResolvedCoordinate } from "./plausibility.ts"
export { foldStreetSurface, isPureTypeVocabulary, pickByStreetEvidence } from "./street-evidence.ts"
export type {
	PickByStreetEvidenceOpts,
	StreetCandidate,
	StreetEvidencePick,
	StreetEvidenceScope,
	StreetLocalityEvidence,
} from "./street-evidence.ts"
export { findRescoreCandidate, hasResolvedPlace } from "./span-rescore.ts"
export type { RescoreCandidate, SpanRescoreOptions } from "./span-rescore.ts"

// The type contract + placetype helpers live in core (pure types, keep core a leaf). Re-export so
// consumers get the whole surface from `@mailwoman/resolver`.
export * from "@mailwoman/core/resolver"

export * from "./rerank.ts"
