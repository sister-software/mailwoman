/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The resolver TYPE CONTRACT — `ResolverBackend`, `Resolver`, `ResolveOpts`, `ResolvedPlace`, the
 *   lookup interfaces, the placetype map. Pure types + tiny helpers; NO implementation, so `core`
 *   stays a dependency-free leaf and `core/pipeline` can compose the resolver structurally without
 *   a cycle. The IMPLEMENTATION (`createWOFResolver`, `RemoteResolver`, span-rescore) lives in
 *   `@mailwoman/resolver` (#215), which depends on this + `@mailwoman/spatial` +
 *   `@mailwoman/codex`.
 */

export { DEFAULT_PLACETYPE_MAP, PLACETYPE_FILTER_GROUPS, expandPlacetypeFilter, isPlacetypeFallback } from "./types.js"
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
	StreetCentroidHit,
	StreetCentroidLookup,
} from "./types.js"
