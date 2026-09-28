/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file US Census geocoder match → mailwoman {@linkcode OracleGeocodeResult}.
 */

import { createPostalAddressID } from "@mailwoman/address-id"
import type { ResolutionTier } from "@mailwoman/annotations/geo"
import type { ComponentDict } from "@mailwoman/codex/address-format"
import { type AddressGeocode, toPostalAddress, withGeocode } from "@mailwoman/record"

import { OracleProvider, type OracleGeocodeResult, regionPrefix } from "#result"
import type { CensusAddressComponents, CensusAddressMatch } from "#sdk/census/types"

/**
 * The tier every Census match carries, without exception.
 *
 * The Census geocoder finds the tiger/Line segment whose address range contains the house number
 * and interpolates a position along it, so `interpolated` here is the mechanism rather than a hedge.
 *
 * A Census coordinate is routinely 20–100 m from the building, and further on a long rural segment.
 * Pin `expectToleranceM` against that rather than against a rooftop assumption.
 */
export const CENSUS_RESOLUTION_TIER: ResolutionTier = "interpolated"

/**
 * The leading house number of a matched address line.
 *
 * The corpus regex is tuned for US CSV extract rows with hand-entry drift and admits a trailing letter
 * and a hyphenated half (`123A`, `40-12`); a Census `matchedAddress` is machine-normalized
 * USPS output whose number is a plain digit run, so this pattern matches that alone.
 * `@mailwoman/corpus`'s declared home for the split is deliberately not used, because reaching it
 * would pull the training-corpus pipeline into a package whose entire job is to make two http calls.
 *
 * If a third caller ever needs the loose form here, take the dependency then.
 */
const HOUSE_NUMBER_PREFIX = /^(\d+)\s+\S/

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
 * - `street_prefix` ← `preDirection`; `preType` deliberately does not land here, because `avenue` in
 *   `Avenue of the Americas` is part of how the street is written rather than a prefix modifier.
 * - `street` ← `preQualifier` + `preType` + `streetName` + `suffixQualifier`, in written order.
 * - `street_suffix` ← `suffixType` + `suffixDirection`, because mailwoman has no separate
 *   suffix-directional tag and the two are adjacent in this order on the envelope (`123 N main ST E`).
 * - `street_prefix_particle` is left unset: it exists for grammatical particles (`de la`, `van der`),
 *   which US street names do not carry and the Census geocoder has no slot for.
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
 * `country` is hardcoded to `US`: the Census geocoder covers the United States
 * and its territories only, there is no field to read it from, and leaving it unset
 * would give every US address a different `canonicalKey`.
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
 * `uncertaintyMeters` is left `null`: the Census geocoder publishes no uncertainty
 * figure, and the honest one for a tiger interpolation depends on segment length
 * and address density, neither in the response.
 */
export function parseCensusAddressMatch<Match extends CensusAddressMatch>(match: Match): OracleGeocodeResult<Match> {
	const components = buildCensusComponents(match)
	// `{ x, y }` is `{ longitude, latitude }` in the Census naming.
	// Read it explicitly rather than through `GeoPoint` so a served coordinate is
	// never discarded by an input validator.
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
		// The Census geocoder has no partial-match signal: a match is either present in `addressMatches`
		// or absent, so a caller wanting its quality reads `raw.tigerLine` and the address range instead.
		partialMatch: false,
		// `tigerLine.tigerLineId` identifies a street segment rather than a place, so it stays on `raw`.
		placeID: null,
		plusCode: null,
		raw: match,
	}
}
