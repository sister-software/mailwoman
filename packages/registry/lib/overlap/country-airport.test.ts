// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Holds every bit of the built collision index equal to a set intersection computed from the normalized JSON, and
 *   checks the discriminated interpretations the operator's rule reads.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { airportMembership } from "#iata/airports/validate"
import { alpha3Membership } from "#iso3166/alpha3"
import { decode3, KEY_SPACE_3 } from "#key"
import { collisionMembership, interpretCountryOrAirportCode, isCountryAirportCollision } from "#overlap/country-airport"

interface Countries {
	records: Array<{ alpha3: string; status: string }>
}

interface Airports {
	records: Array<{ iata: string }>
}

const countries = await readLocalJSONFile<Countries>(workspacePath("registry", "data", "normalized", "iso3166-1.json"))

const airports = await readLocalJSONFile<Airports>(
	workspacePath("registry", "data", "normalized", "iata-airports.json")
)

const currentAlpha3 = new Set(
	countries.records.filter((record) => record.status === "officially-assigned").map((record) => record.alpha3)
)

const airportCodes = new Set(airports.records.map((record) => record.iata))

describe("country/airport collision index", () => {
	it("holds exactly 2,197 payload bytes", () => {
		expect(collisionMembership().size).toBeGreaterThan(0)
		expect(Math.ceil(KEY_SPACE_3 / 8)).toBe(2197)
	})

	it("equals the set intersection of the two memberships over all 17,576 keys", () => {
		let collisions = 0

		for (let key = 0; key < KEY_SPACE_3; key++) {
			const code = decode3(key)
			const country = currentAlpha3.has(code)
			const airport = airportCodes.has(code)

			expect(alpha3Membership().test(key), `alpha3 ${code}`).toBe(country)
			expect(airportMembership().test(key), `airport ${code}`).toBe(airport)
			expect(collisionMembership().test(key), `collision ${code}`).toBe(country && airport)

			if (country && airport) {
				collisions++
			}
		}

		expect(collisionMembership().size).toBe(collisions)
		expect(collisions).toBe([...currentAlpha3].filter((code) => airportCodes.has(code)).length)
	})

	it.each(["AUS", "FRA", "HND", "USA", "MEX", "CAN"])("reads %s as a collision", (code) => {
		expect(isCountryAirportCollision(code)).toBe(true)
	})

	it.each(["SFO", "LHR", "DTW", "aus", "AU", "XXX"])("reads %s as no collision", (code) => {
		expect(isCountryAirportCollision(code)).toBe(false)
	})

	// A country whose alpha-3 code no airport holds, read from the data rather than guessed:
	// `GBR` is Walter J. Koladza Airport, so an example chosen by hand is a hypothesis about the source.
	const countryOnly = [...currentAlpha3].find((code) => !airportCodes.has(code))!

	it(`reads ${countryOnly} as a country and no collision`, () => {
		expect(isCountryAirportCollision(countryOnly)).toBe(false)
		expect(interpretCountryOrAirportCode(countryOnly).map((match) => match.system)).toEqual(["iso3166-1-alpha3"])
	})

	it("answers AUS as Australia under one namespace and a US airport under another", () => {
		const matches = interpretCountryOrAirportCode("AUS")

		expect(matches).toHaveLength(2)
		expect(matches[0]).toMatchObject({ system: "iso3166-1-alpha3", code: "AUS", country: "AU", name: "Australia" })

		expect(matches[1]).toMatchObject({
			system: "iata-location",
			code: "AUS",
			kind: "airport",
			country: "US",
			countryStatus: "iso3166-1",
		})

		expect(matches[1]!.name).toMatch(/Austin/)
	})

	it("answers one interpretation for an airport-only code and none for a miss", () => {
		expect(interpretCountryOrAirportCode("SFO").map((match) => match.system)).toEqual(["iata-location"])
		expect(interpretCountryOrAirportCode("XXX")).toEqual([])
		expect(interpretCountryOrAirportCode("aus")).toEqual([])
	})
})
