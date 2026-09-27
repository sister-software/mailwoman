/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The national Overture rooftop provider: a registered country with its database on disk answers a `zh`-keyed
 *   lookup. a registered country with no database, and an unregistered country, answer `{}` rather than a handle to
 *   no place.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import {
	ADDRESS_POINT_COLUMNS,
	type AddressPointDatabase,
	createAddressPointTable,
} from "@mailwoman/resolver-wof-sqlite/address"
import {
	normalizeHouseNumberForKey,
	normalizeLocalityForKeyLocale,
	normalizeStreetForKeyLocale,
} from "@mailwoman/resolver-wof-sqlite/street"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import {
	licenseForOvertureCountry,
	nationalAddressPointsPath,
	overtureCountryLicense,
	OvertureNationalDatabaseProvider,
	streetLocaleForOvertureCountry,
	supportedOvertureCountries,
} from "mailwoman/geocode"
import { dirname } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

describe("OvertureNationalDatabaseProvider", () => {
	it("registers Taiwan under the zh locale and refuses an unregistered country loudly", () => {
		expect(supportedOvertureCountries()).toContain("tw")
		expect(streetLocaleForOvertureCountry("TW")).toBe("zh")
		expect(() => streetLocaleForOvertureCountry("kr")).toThrow(/COUNTRY_TO_STREET_LOCALE/)
	})

	it("carries the upstream register's license alone, without an Overture addresses-theme grant", () => {
		// Overture's attribution page declares an identifier for every theme but addresses,
		// where it states only that the sources carry permissive open licenses and
		// then lists the register per country.
		// An expression naming `CDLA-Permissive-2.0` here would assert the places grant.
		// Read through `overtureCountryLicense`, because a country whose grant is unsettled
		// has no expression to check and `licenseForOvertureCountry` refuses it.
		for (const country of supportedOvertureCountries()) {
			const entry = overtureCountryLicense(country)

			expect(entry).toBeDefined()
			expect(entry?.expression ?? "").not.toMatch(/CDLA/)
			expect((entry?.candidates ?? []).join(" ")).not.toMatch(/CDLA/)
		}

		expect(licenseForOvertureCountry("es")).toBe("CC-BY-4.0")
		expect(licenseForOvertureCountry("IT")).toBe("CC-BY-4.0")
		expect(() => licenseForOvertureCountry("kr")).toThrow(/COUNTRY_LICENSES/)
	})

	it("refuses Taiwan's grant, because two documents name different licenses over the same rows", () => {
		// Overture's attribution page gives CC BY 4.0 for each of the 18 Civil Affairs bodies,
		// and `counsel-dossier.md` §6 reads OGDL-Taiwan-1.0 over the same municipal 門牌 rows.
		// Recording the stricter of the two states a grant nobody established,
		// and a stricter incorrect attribution is as incorrect as a permissive one.
		expect(() => licenseForOvertureCountry("tw")).toThrow(/unsettled: CC-BY-4\.0 or OGDL-Taiwan-1\.0/)
		expect(() => licenseForOvertureCountry("tw")).toThrow(/counsel-dossier/)
	})

	it("reports Taiwan's candidates without throwing, for a caller reasoning about the grant", () => {
		const taiwan = overtureCountryLicense("TW")

		expect(taiwan?.expression).toBeUndefined()
		expect(taiwan?.candidates).toEqual(["CC-BY-4.0", "OGDL-Taiwan-1.0"])
		expect(taiwan?.evidence).toHaveLength(2)
		expect(taiwan?.register).toBe("OpenAddresses/<bureau> Civil Affairs")

		expect(overtureCountryLicense("es")?.expression).toBe("CC-BY-4.0")
		expect(overtureCountryLicense("kr")).toBeUndefined()
	})

	it("answers {} for a registered country whose database is not on disk, and for an unregistered one", async () => {
		const root = fixtures.use(await temporaryDirectory("overture-national-")).path
		const provider = fixtures.use(await OvertureNationalDatabaseProvider.create(root))

		expect(provider.for("tw")).toEqual({})
		expect(provider.for("TW")).toEqual({})
		expect(provider.for("kr")).toEqual({})
	})

	it("opens the on-disk database with the country's street locale, so a 台/臺 query reaches the register's row", async () => {
		const root = fixtures.use(await temporaryDirectory("overture-national-")).path
		const path = nationalAddressPointsPath(root, "tw")

		await makeDirectories(dirname(path))

		{
			using kdb = new DatabaseClient<AddressPointDatabase>(path)

			await createAddressPointTable(kdb)

			const street = normalizeStreetForKeyLocale("重慶南路一段", "zh")

			kdb
				.prepare(`INSERT INTO address_point VALUES (${ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`)
				.run(
					street,
					street,
					normalizeHouseNumberForKey("１２２號", "zh"),
					null,
					null,
					normalizeLocalityForKeyLocale("臺北市中正區", "zh"),
					"重慶南路一段",
					25.0399658,
					121.5124584,
					"overture:OpenAddresses/Taipei City Government Civil Affairs Bureau",
					"2026-06-17.0",
					"建國里",
					null
				)
		}

		const provider = fixtures.use(await OvertureNationalDatabaseProvider.create(root))
		const lookup = provider.for("tw").addressPoints

		expect(lookup).toBeDefined()

		expect(
			lookup?.find({ street: "重慶南路一段", number: "122號", region: "台北市", subregion: "中正區" })
		).toMatchObject({ lat: 25.0399658, lon: 121.5124584 })

		// One handle per country: the second call is the cached entry.
		expect(provider.for("TW")).toBe(provider.for("tw"))
	})
})
