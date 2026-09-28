/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/resolver` is the address resolver implementation. It depends on
 *   `@mailwoman/spatial` (haversine) and `@mailwoman/codex` (USPS directionals) instead of
 *   reinventing them. The type interface stays in `@mailwoman/core/resolver`, so `core/pipeline`
 *   composes the resolver structurally without a package cycle. This barrel re-exports it, so
 *   `@mailwoman/resolver` is a complete drop-in for `@mailwoman/core/resolver`.
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

export * from "#rerank"
