// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

export { RemoteResolver, serializableResolveOpts } from "./remote-resolver.js"
export type {
	RemoteResolverOpts,
	ResolveTreeRequest,
	ResolveTreeResponse,
	SerializableResolveOpts,
} from "./remote-resolver.js"
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
