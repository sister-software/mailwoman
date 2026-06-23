/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export { RemoteResolver, serializableResolveOpts } from "./remote-resolver.js"
export type {
	RemoteResolverOpts,
	ResolveTreeRequest,
	ResolveTreeResponse,
	SerializableResolveOpts,
} from "./remote-resolver.js"
export { createWofResolver } from "./resolve.js"
// #370 span-rescore — the pure, backend-agnostic recovery (raw-token enumeration + exact same-country
// gazetteer match + postcode gate). Exported so consumers off the `resolveTree` path — e.g. the demo's
// browser httpvfs cascade — can reuse it instead of re-deriving. No node deps; browser-safe.
export { haversineKm } from "../spatial.js"
export { findRescoreCandidate, hasResolvedPlace } from "./span-rescore.js"
export type { RescoreCandidate, SpanRescoreOptions } from "./span-rescore.js"
export { DEFAULT_PLACETYPE_MAP, PLACETYPE_FILTER_GROUPS, expandPlacetypeFilter } from "./types.js"
export type {
	AddressPointHit,
	AddressPointLookup,
	Ancestor,
	CoincidentLocality,
	InterpolatedPointHit,
	InterpolationLookup,
	PlacetypeMap,
	ResolveOpts,
	ResolvedPlace,
	Resolver,
	ResolverBackend,
} from "./types.js"
