/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The brands refuse interchange at compile time, and the predicates narrow at run time. The `@ts-expect-error` lines
 *   are the test: `yarn typecheck` fails when one of them stops being an error.
 */

import { describe, expect, it } from "vitest"

import { isAirportCode } from "#iata/airports/validate"
import { isCountryCodeAlpha2 } from "#iso3166/alpha2"
import { isCountryCodeAlpha3 } from "#iso3166/alpha3"
import type { IATA, ICAO, ISO } from "#types"

function takesCountry(code: ISO.CountryCode_3166_1_Alpha3): string {
	return code
}

function takesAirport(code: IATA.AirportCode): string {
	return code
}

function takesIndicator(code: ICAO.LocationIndicator): string {
	return code
}

describe("brands", () => {
	it("narrow through the predicates and refuse interchange", () => {
		const input = "AUS"

		if (isCountryCodeAlpha3(input)) {
			expect(takesCountry(input)).toBe("AUS")
			// @ts-expect-error an alpha-3 country code is not an airport code
			takesAirport(input)
			// @ts-expect-error an alpha-3 country code is not an ICAO indicator
			takesIndicator(input)
		}

		if (isAirportCode(input)) {
			expect(takesAirport(input)).toBe("AUS")
			// @ts-expect-error an airport code is not a country code
			takesCountry(input)
		}

		if (isCountryCodeAlpha2("AU")) {
			// @ts-expect-error an alpha-2 code is not an alpha-3 code
			takesCountry("AU" as ISO.CountryCode_3166_1_Alpha2)
		}

		// @ts-expect-error a plain string is not branded
		takesCountry("AUS")
	})
})
