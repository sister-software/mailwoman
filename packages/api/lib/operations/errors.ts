/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIErrorSchema } from "@mailwoman/api-kit"

/**
 * The 501 a route answers when the backing engine method is absent.
 */
export const NotImplementedErrorSchema = APIErrorSchema.meta({
	description: "The backing engine method is not wired for this deployment.",
})

/**
 * The 503 a route answers when the geocoding dependencies are missing.
 */
export const GeocoderUnavailableErrorSchema = APIErrorSchema.meta({
	description: "The geocoding engine is not wired for this deployment (dependencies missing).",
})
