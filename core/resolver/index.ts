/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export { createWofResolver } from "./resolve.js"
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
