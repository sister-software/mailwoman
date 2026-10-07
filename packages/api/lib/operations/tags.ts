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
 * The OpenAPI tag for the liveness and diagnostics operations.
 */
export const MetaTag = { name: "meta", description: "Service liveness and diagnostics." } as const satisfies APITag
