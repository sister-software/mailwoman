/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * The geocoder resolution tier that produced a coordinate, matching `GeocodeResult.resolution_tier`.
 */
export type ResolutionTier = "address_point" | "interpolated" | "street" | "admin" | "venue" | "plus_code"
