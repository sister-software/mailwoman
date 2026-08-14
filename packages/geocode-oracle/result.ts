/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The one shape every reference geocoder in this package answers with, so a gauntlet-case author
 *   can diff two oracles against each other and against the parser without re-learning a response
 *   schema per provider.
 *
 *   It is deliberately built out of the repo's OWN types rather than a bespoke one:
 *   {@linkcode PostalAddress} from `@mailwoman/record` (which carries a `ComponentTag`-keyed
 *   {@linkcode ComponentDict}, the formatter's `canonicalKey`, and an `AddressGeocode`), plus a
 *   {@linkcode PostalAddressID} from `@mailwoman/address-id`. That is what makes the oracle's output
 *   directly comparable to a `SeedCase` in `mailwoman/eval-harness/gauntlet/cases/regression.ts`,
 *   whose assertion fields are `expectComponents` (a tag→value map), `expectLat`/`expectLon`,
 *   `expectToleranceM` and `expectTier` — the same four things, under the same vocabulary.
 *
 *   ORACLE, NOT TRUTH. Nothing here is authoritative. Google and the Census Bureau disagree with each
 *   other, with the postal authority, and with the address as written, and both will confidently
 *   return a coordinate for an address that does not exist. The value of running one is that a HUMAN
 *   authoring a gauntlet case gets a second opinion with provenance attached, not that a case can be
 *   auto-generated. {@linkcode OracleGeocodeResult.raw} exists for exactly this reason: whenever the
 *   component mapping had to make a judgement call (see `google-parser.ts`'s region-form note), the
 *   provider's untouched answer is still in hand.
 */

import type { PostalAddressID } from "@mailwoman/address-id"
import type { PostalAddress } from "@mailwoman/record"

/**
 * The resolution tiers, re-exported so a consumer comparing an oracle answer against a `SeedCase.expectTier` needs one
 * import.
 *
 * @see `ResolutionTier` in `@mailwoman/record` for the ordering (`address_point` > `interpolated` > `street` > `admin`).
 */
export type { ResolutionTier } from "@mailwoman/record"

/**
 * Which reference geocoder produced a result. A plain const object rather than an `enum` — `erasableSyntaxOnly` is on
 * repo-wide.
 */
export const OracleProvider = {
	/**
	 * Google Geocoding API (`maps.googleapis.com/maps/api/geocode/json`). Global coverage, billed per request.
	 */
	Google: "google",
	/**
	 * US Census Bureau geocoder (`geocoding.geo.census.gov`). US only, free, TIGER-derived.
	 */
	Census: "census",
} as const

/**
 * Which reference geocoder produced a result.
 */
export type OracleProvider = (typeof OracleProvider)[keyof typeof OracleProvider]

/**
 * One match from a reference geocoder, normalized onto mailwoman's own record vocabulary.
 *
 * @typeParam Raw The provider's untouched match object. Narrowed by each client so a caller that reaches for `raw`
 *   keeps full typing without a cast.
 */
export interface OracleGeocodeResult<Raw = unknown> {
	/**
	 * Which reference geocoder answered.
	 */
	provider: OracleProvider
	/**
	 * The match as a canonical mailwoman address record: `ComponentTag`-keyed components, the formatter's `canonicalKey`,
	 * a `formatted` single line, and a `geocode` carrying the coordinate + tier.
	 *
	 * `geocode` is always populated here — a reference geocoder that returned no coordinate is not a match, and the
	 * clients raise rather than hand back a coordinate-less record.
	 */
	address: PostalAddress
	/**
	 * The stable `<state>.<H3-cell>.<hash>` key for this match, so two providers' answers for one input can be compared
	 * by identity rather than by string equality on a formatted line.
	 */
	addressID: PostalAddressID
	/**
	 * The provider's own admission that the match is approximate — Google's `partial_match`, which it sets when it had to
	 * fall back from the query it was given. Always `false` for the Census geocoder, which has no equivalent signal.
	 *
	 * Treat a `true` here as "do not pin this case without reading the raw result".
	 */
	partialMatch: boolean
	/**
	 * The provider's own stable identifier for the matched place, when it has one: a Google Place ID, or `null` for the
	 * Census geocoder (whose `tigerLine.tigerLineId` identifies a street SEGMENT, not a place, and is carried on
	 * {@linkcode OracleGeocodeResult.raw} instead).
	 */
	placeID: string | null
	/**
	 * The Open Location Code (plus code) for the match, when the provider supplies one. Google only.
	 */
	plusCode: string | null
	/**
	 * The provider's untouched match. Read this whenever the component mapping's judgement calls matter — it is the
	 * escape hatch that keeps those calls from being lossy.
	 */
	raw: Raw
}

/**
 * A region value narrowed to something usable as {@linkcode createPostalAddressID}'s `state` prefix, or `undefined` so
 * that function falls back to its own derivation.
 *
 * `createPostalAddressID` interpolates `state` into the key WITHOUT validating it, while `parsePostalAddressID` and
 * `isPostalAddressID` both require `^[a-z]{2}\.`. Handing it `Île-de-France` therefore mints an ID that the package's
 * own parser rejects — and an ID that cannot be read back is strictly worse than one that says `xx`. Only a bare
 * two-letter code passes (`NY` yes, `NSW` correctly no).
 *
 * Lives here rather than in either parser because both need it and neither owns it.
 */
export function regionPrefix(region: string | undefined): string | undefined {
	return region !== undefined && /^[A-Za-z]{2}$/.test(region) ? region : undefined
}
