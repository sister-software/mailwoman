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

export { RemoteResolver, serializableResolveOpts } from "#remote-resolver"

export type {
	RemoteResolverOpts,
	ResolveTreeRequest,
	ResolveTreeResponse,
	SerializableResolveOpts,
} from "#remote-resolver"

export { createWOFResolver } from "#resolve"

export { COUNTRY_BBOX, finestResolvedCoordinate, isImplausibleResolution, outsideExpectedCountry } from "#plausibility"

export type { PlausibilityOpts, PlausibilityVerdict, ResolvedCoordinate } from "#plausibility"
export { foldStreetSurface, isPureTypeVocabulary, pickByStreetEvidence } from "#street/evidence"

export type {
	PickByStreetEvidenceOpts,
	StreetCandidate,
	StreetEvidencePick,
	StreetEvidenceScope,
	StreetLocalityEvidence,
} from "#street/evidence"

export {
	findPostcodeCountryScope,
	firstLocalityValue,
	localityValuesInDocumentOrder,
	POSTCODE_COUNTRY_COHERENCE_THRESHOLD_KM,
	stampPostcodeCountryScope,
} from "#postcode/country-coherence"

export type { PostcodeCountryScope, PostcodeCountryScopeOpts } from "#postcode/country-coherence"
export { findRescoreCandidate, hasResolvedPlace } from "#span-rescore"
export type { RescoreCandidate, SpanRescoreOptions } from "#span-rescore"
export { adminContainmentVerdict, partitionByContainment } from "#admin/containment"

export {
	ADMIN_LADDER_LOCALITY_FIRST,
	ADMIN_LADDER_POSTCODE_FIRST,
	adminLadderFor,
	adminLadderForNodes,
	AREA_GRADE_POSTALCODE_SPECIFICITY,
	mostSpecificResolved,
	resolvedSpecificity,
} from "#admin/winner"

export type { ResolvedPostcodeHit, ResolvedSpecificityInput } from "#admin/winner"

// The type contract + placetype helpers live in core (pure types, keep core a leaf). Re-export so
// consumers get the whole surface from `@mailwoman/resolver`.
export * from "@mailwoman/core/resolver"

export * from "#rerank"
