// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A request's `defaultCountry` scopes that request's resolver and leaves the session's scope as it was.
 *
 *   Each run states the locale and country scope it answered under.
 *
 *   A session's coarse placer is the place-country service every runtime pipeline reads.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { describe, expect, it } from "vitest"

import { localeToCountry } from "#country-scope"
import { createGeocodeSessionOptions, GEOCODE_DEFAULT_LOCALE } from "#geocode/options"
import { createGeocodeSession, type GeocodeRequestOptions } from "#geocode/session"

/**
 * The country the session reads off its default locale.
 */
const GEOCODE_DEFAULT_COUNTRY = localeToCountry(GEOCODE_DEFAULT_LOCALE)

const haveGazetteer = await pathExists(wofDatabasePath("candidate.db"))

describe.skipIf(!haveGazetteer)("a request's default country", () => {
	it("scopes that request, and the next request without one is unscoped again", async () => {
		await using session = await createGeocodeSession(createGeocodeSessionOptions({ countryScope: "none" }))

		const before = await session.geocode("Paris")
		const scoped = await session.geocode("Paris", { defaultCountry: "US" })
		const after = await session.geocode("Paris")

		expect({
			before: before.result.countryCode,
			scoped: scoped.result.countryCode,
			after: after.result.countryCode,
		}).toEqual({ before: "FR", scoped: "US", after: "FR" })

		expect(after.result).toEqual(before.result)
	}, 120_000)
})

describe.skipIf(!haveGazetteer)("the record of what a geocode ran under", () => {
	it("states the scope the resolver was given, its source, and why a locale's scope didn't filter", async () => {
		await using session = await createGeocodeSession(createGeocodeSessionOptions())

		const scopeOf = async (input: string, request?: GeocodeRequestOptions) =>
			(await session.geocode(input, request)).applied.countryScope

		const inferred = { country: GEOCODE_DEFAULT_COUNTRY, source: "inferred", strength: "hard" }

		// An address with no evidence of another country takes the locale's country as a filter.
		expect(await scopeOf("1600 Pennsylvania Avenue NW, Washington, DC 20500")).toEqual({
			resolver: inferred,
			withheld: null,
		})

		// Montréal, Québec outranks Montreal, Wisconsin beyond the soft scope's bonus.
		expect(await scopeOf("1001 Boulevard Saint-Laurent, Montréal")).toEqual({
			resolver: null,
			withheld: { country: GEOCODE_DEFAULT_COUNTRY, reason: "larger_namesake_abroad" },
		})

		// A Singapore register address has zero match inside the locale's country.
		expect(await scopeOf("10 Meragi Close S(487972)")).toEqual({
			resolver: null,
			withheld: { country: GEOCODE_DEFAULT_COUNTRY, reason: "no_match_in_country" },
		})

		// The locale head reads a military address as the locale's country, so a miss keeps the scope.
		expect(await scopeOf("Unit 2050 Box 4190, DPO AP 96278")).toEqual({ resolver: inferred, withheld: null })

		expect(await scopeOf("Paris")).toEqual({
			resolver: null,
			withheld: { country: GEOCODE_DEFAULT_COUNTRY, reason: "bare_locality" },
		})

		expect(await scopeOf("SW1A 1AA")).toEqual({
			resolver: null,
			withheld: { country: GEOCODE_DEFAULT_COUNTRY, reason: "bare_postcode_format_conflict" },
		})

		// The locale head reads a British address, and the postcode's format excludes the locale's country.
		expect(await scopeOf("10 Downing Street, London SW1A 2AA")).toEqual({
			resolver: null,
			withheld: { country: GEOCODE_DEFAULT_COUNTRY, reason: "contradicting_evidence" },
		})

		expect(await scopeOf("Paris", { defaultCountry: "FR" })).toEqual({
			resolver: { country: "FR", source: "caller", strength: "hard" },
			withheld: null,
		})
	}, 120_000)

	it("answers abroad when the address shows the evidence, and in the locale's country when it shows none", async () => {
		await using session = await createGeocodeSession(createGeocodeSessionOptions())

		const countryOf = async (input: string) => (await session.geocode(input)).result.countryCode

		expect({
			namesake: await countryOf("1001 Boulevard Saint-Laurent, Montréal"),
			miss: await countryOf("10 Meragi Close S(487972)"),
			barePostcode: await countryOf("90210"),
			military: await countryOf("PSC 802 Box 74, APO AE 09499"),
		}).toEqual({ namesake: "CA", miss: "SG", barePostcode: GEOCODE_DEFAULT_COUNTRY, military: GEOCODE_DEFAULT_COUNTRY })
	}, 120_000)

	it("keeps the locale's country as a filter for every input under countryScope locale", async () => {
		await using session = await createGeocodeSession(createGeocodeSessionOptions({ countryScope: "locale" }))

		const run = await session.geocode("1001 Boulevard Saint-Laurent, Montréal")

		expect(run.applied.countryScope).toEqual({
			resolver: { country: GEOCODE_DEFAULT_COUNTRY, source: "caller", strength: "hard" },
			withheld: null,
		})

		expect(run.result.countryCode).toBe(GEOCODE_DEFAULT_COUNTRY)
	}, 120_000)

	it("states a locale the caller chose as the caller's, and zero scope under countryScope none", async () => {
		await using session = await createGeocodeSession(
			createGeocodeSessionOptions({ locale: GEOCODE_DEFAULT_LOCALE, countryScope: "none" })
		)

		expect((await session.geocode("1001 Boulevard Saint-Laurent, Montréal")).applied).toEqual({
			locale: { locale: GEOCODE_DEFAULT_LOCALE, source: "caller" },
			countryScope: { resolver: null, withheld: null },
		})
	}, 120_000)
})

describe.skipIf(!haveGazetteer)("a session's coarse placer", () => {
	it("is the place-country service on its scope, with the full in-map distribution", async () => {
		await using session = await createGeocodeSession(createGeocodeSessionOptions({ countryScope: "none" }))

		// The session hands `geocodeAddress` this function as it is, so the resolver's anchor is its posterior.
		const placed = session.services.placeCountry?.("350 5th Ave, New York, NY 10118")

		expect(placed?.country).toBe("US")
		expect(Object.keys(placed?.posterior ?? {}).length).toBeGreaterThan(1)
	}, 120_000)

	it("is absent when the session's `placeCountry` option is off", async () => {
		await using session = await createGeocodeSession(
			createGeocodeSessionOptions({ countryScope: "none", placeCountry: false })
		)

		expect(session.services.placeCountry).toBeNull()
	}, 120_000)
})
