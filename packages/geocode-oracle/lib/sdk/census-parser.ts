/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file US Census geocoder match → mailwoman {@linkcode OracleGeocodeResult}.
 *
 *   Two things the isp-nexus original did not do, both of which matter for a gauntlet-case oracle:
 *
 *     1. **It recorded no accuracy at all.** Every Census match is an interpolation along a TIGER
 *        address range — never a rooftop — so the tier is a CONSTANT here, and stating it is the whole
 *        point. See {@linkcode CENSUS_RESOLUTION_TIER}.
 *     2. **It never extracted the house number.** `addressComponents` carries the street name split
 *        seven ways but no house number; only the RANGE endpoints (`fromAddress`/`toAddress`) are
 *        there. The matched number lives in `matchedAddress` alone, so a Census-sourced address record
 *        came out with a street and no number on it. See {@linkcode HOUSE_NUMBER_PREFIX}.
 */

import { createPostalAddressID } from "@mailwoman/address-id"
import type { ComponentDict } from "@mailwoman/formatter"
import { type AddressGeocode, type ResolutionTier, toPostalAddress, withGeocode } from "@mailwoman/record"

import { OracleProvider, type OracleGeocodeResult, regionPrefix } from "#result"
import type { CensusAddressComponents, CensusAddressMatch } from "#sdk/census-types"

/**
 * The tier every Census match carries, without exception.
 *
 * The Census geocoder locates an address by finding the TIGER/Line segment whose address range contains the house
 * number and interpolating a position along it — which is what `tigerLine.tigerLineId`, `tigerLine.side` and
 * `addressComponents.fromAddress`/`toAddress` are all evidence of. There is no parcel or structure layer behind it, so
 * it cannot produce a rooftop coordinate even for an address it matches perfectly. `interpolated` is not a hedge here;
 * it is the mechanism.
 *
 * A consequence worth carrying into a gauntlet case: a Census coordinate is routinely 20–100 m from the building, and
 * further on a long rural segment. Pin `expectToleranceM` against that, not against a rooftop assumption.
 */
export const CENSUS_RESOLUTION_TIER: ResolutionTier = "interpolated"

/**
 * The leading house number of a matched address line.
 *
 * `@mailwoman/corpus`'s `HOUSE_NUMBER_PREFIX` (`corpus/src/adapter.ts`) is this repo's declared home for the
 * house-number/street split, and it is DELIBERATELY not used here. Reaching it means taking a dependency on
 * `@mailwoman/corpus`, which brings `parquet-wasm`, `apache-arrow`, `@mailwoman/ban`, `spliterator` and the rest of the
 * training-corpus pipeline behind it — for one regular expression, into a package whose entire job is to make two HTTP
 * calls. The dependency is what is wrong, not the sharing.
 *
 * The shapes also differ. The corpus regex is tuned for US CSV extract rows with hand-entry drift, so it admits a
 * trailing letter and a hyphenated half (`123A`, `40-12`). A Census `matchedAddress` is machine-normalized USPS output
 * where the number is a plain digit run; this pattern matches that and nothing else, which is the right strictness for
 * a value that is about to be asserted on. If a third caller ever needs the loose form here, take the dependency then.
 */
const HOUSE_NUMBER_PREFIX = /^(\d+)\s+\S/

/**
 * Join the present pieces of a multi-slot street span with single spaces.
 */
function joinParts(...parts: Array<string | undefined>): string | undefined {
	const joined = parts
		.map((part) => part?.trim())
		.filter((part): part is string => Boolean(part))
		.join(" ")

	return joined || undefined
}

/**
 * Fold the Census geocoder's seven-slot street decomposition into mailwoman's four `ComponentTag`s.
 *
 * The mapping, and why each choice:
 *
 * - `street_prefix` ← `preDirection`. The tag means the directional in front of the name, which is exactly this slot.
 *   `preType` deliberately does NOT land here: `AVENUE` in `Avenue of the Americas` is part of how the street is
 *   written, not a prefix modifier, and a parser reading that input emits it inside `street`.
 * - `street` ← `preQualifier` + `preType` + `streetName` + `suffixQualifier`. The words that make up the name as written,
 *   in written order.
 * - `street_suffix` ← `suffixType` + `suffixDirection`. mailwoman has no separate suffix-directional tag, and the two are
 *   adjacent and in this order on the envelope (`123 N MAIN ST E` → suffix `ST E`).
 * - `street_prefix_particle` is left unset. It exists for grammatical particles (`de la`, `van der`), which US street
 *   names do not carry and the Census geocoder has no slot for.
 */
export function buildStreetComponents(components: CensusAddressComponents): ComponentDict {
	const dict: ComponentDict = {}

	const prefix = components.preDirection?.trim()

	const street = joinParts(
		components.preQualifier,
		components.preType,
		components.streetName,
		components.suffixQualifier
	)

	const suffix = joinParts(components.suffixType, components.suffixDirection)

	if (prefix) {
		dict.street_prefix = prefix
	}

	if (street) {
		dict.street = street
	}

	if (suffix) {
		dict.street_suffix = suffix
	}

	return dict
}

/**
 * Build the full `ComponentTag` dictionary for one match.
 *
 * `country` is hardcoded to `US`. The Census geocoder covers the United States and its territories and nothing else —
 * there is no field to read it from, and leaving it unset would make the formatter render a country-less line and the
 * `canonicalKey` differ from every other US address in the repo for no reason.
 */
export function buildCensusComponents(match: CensusAddressMatch): ComponentDict {
	const source = match.addressComponents
	const dict: ComponentDict = { ...buildStreetComponents(source), country: "US" }

	const houseNumber = HOUSE_NUMBER_PREFIX.exec(match.matchedAddress)?.[1]

	if (houseNumber) {
		dict.house_number = houseNumber
	}

	if (source.city?.trim()) {
		dict.locality = source.city.trim()
	}

	if (source.state?.trim()) {
		dict.region = source.state.trim()
	}

	if (source.zip?.trim()) {
		dict.postcode = source.zip.trim()
	}

	return dict
}

/**
 * Turn one Census `addressMatches` entry into the package's normalized {@linkcode OracleGeocodeResult}.
 *
 * `uncertaintyMeters` is left `null`: the Census geocoder publishes no uncertainty figure, and the honest one for a
 * TIGER interpolation depends on the segment's length and address density, neither of which is in the response.
 */
export function parseCensusAddressMatch<Match extends CensusAddressMatch>(match: Match): OracleGeocodeResult<Match> {
	const components = buildCensusComponents(match)
	// `{ x, y }` is `{ longitude, latitude }` in the Census geocoder's naming, matching
	// `InternalPointCoordinates`. Read explicitly rather than through `GeoPoint` so a coordinate the
	// provider actually served is never discarded by an input validator — see `google-parser.ts`.
	const coordinate = { latitude: match.coordinates.y, longitude: match.coordinates.x }

	const geocode: AddressGeocode = {
		coordinate,
		tier: CENSUS_RESOLUTION_TIER,
		uncertaintyMeters: null,
	}

	const address = withGeocode(toPostalAddress(components, { country: "US", raw: match.matchedAddress }), geocode)

	return {
		provider: OracleProvider.Census,
		address,
		addressID: createPostalAddressID({
			coordinate,
			address: match.matchedAddress,
			state: regionPrefix(components.region),
		}),
		// The Census geocoder has no partial-match signal. A match is a match or it is absent from
		// `addressMatches` entirely — which is why a caller wanting to know how good one is reads
		// `raw.tigerLine` and the address range rather than a flag.
		partialMatch: false,
		// `tigerLine.tigerLineId` identifies a street SEGMENT, not a place, so it is not a place ID.
		// It stays on `raw`.
		placeID: null,
		plusCode: null,
		raw: match,
	}
}
