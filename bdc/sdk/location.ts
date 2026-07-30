/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Tagged } from "type-fest"

/**
 * Matches a 10-digit FCC Broadband Serviceable Location ID, leading zeros included.
 *
 * @see {@linkcode isBroadbandServicableLocationID} for the type-predicate that uses this.
 */
export const BROADBAND_SERVICABLE_LOCATION_INPUT_PATTERN = /^\d{10}$/

/**
 * Unique ID for the Fabric location.
 *
 * The BSL ID remains persistent version to version when newer evidence indicates the position of the serviceable
 * location or the presence of a serviceable location on a single location parcel is not significantly changed as
 * compared to the prior version.
 *
 * - While IDs persist across Fabric versions does not mean that the latitude and longitude are unchanged.
 * - An ID will remain consistent across versions when a different building is selected on a single parcel.
 *
 * Typed as a `string`, not a `number` — the FCC's own IDs are 10-digit zero-padded strings, and leading zeros make
 * integer storage lossy.
 *
 * @type string
 * @title Broadband Servicable Location ID
 * @pattern ^\d{10}$
 */
export type BroadbandServicableLocationID = Tagged<string, "BroadbandServicableLocationID">

/**
 * Type-predicate for checking if a value appears to be a valid Broadband Servicable Location ID.
 *
 * Accepts only a 10-digit string. A `number` input is always rejected, even if its digits would otherwise match —
 * numeric storage would silently drop meaningful leading zeros.
 *
 * @internal
 */
export function isBroadbandServicableLocationID(input: unknown): input is BroadbandServicableLocationID {
	return typeof input === "string" && BROADBAND_SERVICABLE_LOCATION_INPUT_PATTERN.test(input)
}
