/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Every geocoder resolution tier, most precise first.
 */
export const RESOLUTION_TIERS = ["address_point", "interpolated", "street", "admin", "venue", "plus_code"] as const

/**
 * The geocoder resolution tier that produced a coordinate, matching `GeocodeResult.resolution_tier`.
 */
export type ResolutionTier = (typeof RESOLUTION_TIERS)[number]
