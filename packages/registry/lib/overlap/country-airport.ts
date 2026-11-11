/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The country/airport collision index: codes that are both an officially assigned ISO 3166-1 alpha-3 code and an
 *   IATA airport code in the profile.
 *
 *   `isCountryAirportCollision` reads only the 2,197-byte collision bitset. `interpretCountryOrAirportCode` reads the
 *   records artifacts and answers every interpretation as a discriminated union, each branch with its own brand and
 *   entity, so `AUS` is Australia under one namespace and an airport in the United States under another. The two
 *   relations are separate: `same-spelling-as` is the collision, `located-in` is each branch's `country`. The caller
 *   ranks the interpretations, and the resolver in Mailwoman does it.
 */

import { countryAirportCollisionArtifact } from "#artifacts/country-airport-collision"
import { airportRowByIATA, getAirportByIATA } from "#iata/airports/records"
import { getCountryByAlpha3 } from "#iso3166/records"
import { encode3 } from "#key"
import { Artifact } from "#rgy1/reader"
import { BitsetView } from "#rgy1/views"
import { type AirportCountryStatus, CountryStatus, type IATA, type ISO } from "#types"

let bitset: BitsetView | null = null

/**
 * Returns the collision bitset, parsing the artifact on first use.
 */
export function collisionMembership(): BitsetView {
	bitset ??= BitsetView.of(Artifact.parse(countryAirportCollisionArtifact()))

	return bitset
}

/**
 * Whether a three-letter code in its canonical spelling is both a current country code and an airport code.
 */
export function isCountryAirportCollision(input: string): boolean {
	return collisionMembership().test(encode3(input))
}

/**
 * One interpretation of a three-letter spelling.
 */
export type CodeMatch =
	| {
			system: "iso3166-1-alpha3"
			code: ISO.CountryCode_3166_1_Alpha3
			/**
			 * The alpha-2 code of the same entity.
			 */
			country: string
			entityID: string
			name: string
	  }
	| {
			system: "iata-location"
			code: IATA.AirportCode
			kind: "airport"
			/**
			 * The alpha-2 code the source places the airport in, or null for an extension or an unstated country.
			 */
			country: string | null
			countryStatus: AirportCountryStatus
			entityID: string
			name: string
	  }

/**
 * Every namespace that holds the spelling, in namespace order: country first, then airport.
 *
 * The order is the namespace list's and isn't a ranking.
 * An empty array is `not-found-in-snapshot` in every namespace, and a former country code
 * isn't an interpretation here because the current-assignment brand leaves it out.
 */
export function interpretCountryOrAirportCode(input: string): CodeMatch[] {
	const matches: CodeMatch[] = []

	if (encode3(input) < 0) return matches

	const country = getCountryByAlpha3(input)

	if (country && country.status === CountryStatus.OfficiallyAssigned) {
		matches.push({
			system: "iso3166-1-alpha3",
			code: input as ISO.CountryCode_3166_1_Alpha3,
			country: country.alpha2,
			entityID: country.entityID,
			name: country.name,
		})
	}

	if (airportRowByIATA(input) >= 0) {
		const airport = getAirportByIATA(input)!

		matches.push({
			system: "iata-location",
			code: airport.iata,
			kind: "airport",
			country: airport.countryStatus === "iso3166-1" ? airport.country : null,
			countryStatus: airport.countryStatus,
			entityID: airport.entityID,
			name: airport.name,
		})
	}

	return matches
}
