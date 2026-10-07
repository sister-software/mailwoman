/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { APITag } from "@mailwoman/api-kit/operation"

/**
 * The OpenAPI tag for the parse operations.
 */
export const ParsingTag = {
	name: "parsing",
	description: "Split an address into its components.",
} as const satisfies APITag

/**
 * The OpenAPI tag for the geocode operations.
 */
export const GeocodingTag = {
	name: "geocoding",
	description: "Resolve an address to coordinates.",
} as const satisfies APITag

/**
 * The OpenAPI tag for resolving an already-decoded address tree.
 */
export const ResolvingTag = {
	name: "resolving",
	description: "Resolve an already-decoded address tree against the gazetteer.",
} as const satisfies APITag

/**
 * The OpenAPI tag for rendering components back into an address.
 */
export const FormattingTag = {
	name: "formatting",
	description: "Render address components to a string, the inverse of parsing.",
} as const satisfies APITag

/**
 * The OpenAPI tag for point-of-interest search.
 */
export const POITag = { name: "poi", description: "Search for points of interest." } as const satisfies APITag

/**
 * The OpenAPI tag for the liveness and diagnostics operations.
 */
export const MetaTag = {
	name: "meta",
	description: "Service liveness, metrics and deploy-time operations.",
} as const satisfies APITag
