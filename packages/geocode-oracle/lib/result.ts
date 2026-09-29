/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The one shape every reference geocoder in this package answers with, built from the repo's own
 *   `PostalAddress` and `PostalAddressID` types so an oracle answer is directly comparable to a
 *   `SeedCase` in the gauntlet.
 *
 *   Oracle results are not authoritative. {@linkcode OracleGeocodeResult.raw} preserves the provider's untouched answer.
 *   Use that answer when component mapping requires a judgment call.
 */

import type { PostalAddressID } from "@mailwoman/address-id"
import type { PostalAddress } from "@mailwoman/record"

/**
 * Which reference geocoder produced a result.
 *
 * A plain const object rather than an `enum`, because `erasableSyntaxOnly` is on repo-wide.
 */
export const OracleProvider = {
	/**
	 * Google Geocoding API (`maps.googleapis.com/maps/api/geocode/json`).
	 *
	 * Global coverage, billed per request.
	 */
	Google: "google",
	/**
	 * US Census Bureau geocoder (`geocoding.geo.census.gov`).
	 *
	 * US only, free, tiger-derived.
	 */
	Census: "census",
} as const

/**
 * The provider names an {@linkcode OracleGeocodeResult} can include.
 */
export type OracleProvider = (typeof OracleProvider)[keyof typeof OracleProvider]

/**
 * One match from a reference geocoder, normalized onto mailwoman's own record vocabulary.
 *
 * @typeParam Raw The provider's untouched match object. Narrowed by each client so a caller that reaches for `raw`
 *   keeps full typing without a cast.
 */
export interface OracleGeocodeResult<Raw = unknown> {
	provider: OracleProvider
	/**
	 * The match as a canonical mailwoman address record.
	 *
	 * `geocode` is always populated.
	 * A reference geocoder with no coordinate does not produce a match.
	 *
	 * The clients raise an error instead of returning a coordinate-less record.
	 */
	address: PostalAddress
	/**
	 * The stable `<state>.<H3-cell>.<hash>` key, so two providers' answers for one input
	 * compare by identity rather than by string equality on a formatted line.
	 */
	addressID: PostalAddressID
	/**
	 * The provider's own admission that the match is approximate: Google's `partial_match`,
	 * always `false` for the Census geocoder and any other provider with no equivalent signal.
	 *
	 * Treat a `true` here as "do not pin this case without reading the raw result".
	 */
	partialMatch: boolean
	/**
	 * The provider's own stable identifier for the matched place, or `null` for the
	 * Census geocoder whose `tigerLine.tigerLineId` identifies a street segment
	 * and lives on {@linkcode OracleGeocodeResult.raw}.
	 */
	placeID: string | null
	/**
	 * The Open Location Code (plus code) for the match.
	 * Google only.
	 */
	plusCode: string | null
	/**
	 * The override that keeps a component mapping's judgement calls from being lossy.
	 *
	 * Read this whenever the component mapping's judgement calls matter.
	 */
	raw: Raw
}

/**
 * A region value narrowed to something usable as {@linkcode createPostalAddressID}'s
 * `state` prefix, or `undefined` so that function falls back to its own derivation.
 *
 * `createPostalAddressID` interpolates `state` into the key unvalidated while `parsePostalAddressID`
 * and `isPostalAddressID` require `^[a-z]{2}\.`, so only a bare two-letter code passes
 * and an ID that cannot be read back is worse than one that reports `xx`.
 *
 * Lives here rather than in either parser because both need it and neither owns it.
 */
export function regionPrefix(region: string | undefined): string | undefined {
	return region !== undefined && /^[A-Za-z]{2}$/.test(region) ? region : undefined
}
