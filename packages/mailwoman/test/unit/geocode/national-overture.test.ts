/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The national Overture rooftop provider answers a `zh`-keyed lookup for a registered country with its database on disk, and `{}` for one without a database or unregistered.
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
		// Overture declares no addresses-theme grant, so a CDLA expression here would assert a places grant.
		// Read through `overtureCountryLicense` because `licenseForOvertureCountry`
		// refuses an unsettled country.
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

	it("stamps Taiwan's grant as the conjunction, because a row through Overture is bound by both", () => {
		// Two documents describe two grants over the same municipal 門牌 rows rather than
		// disagreeing about one: Overture states the terms it redistributes under,
		// and the counsel dossier reads the originating agencies' own grant.
		// Each carries Attribution alone, so the conjunction adds no obligation either lacks,
		// and naming one alone would drop the other's conditions (#2369).
		expect(licenseForOvertureCountry("tw")).toBe("CC-BY-4.0 AND OGDL-Taiwan-1.0")
	})

	it("reports Taiwan's evidence beside its expression, so a reader sees which document gave which grant", () => {
		const taiwan = overtureCountryLicense("TW")

		expect(taiwan?.expression).toBe("CC-BY-4.0 AND OGDL-Taiwan-1.0")
		expect(taiwan?.evidence).toHaveLength(2)
		expect(taiwan?.evidence[0]).toContain("Overture attribution page")
		expect(taiwan?.evidence[1]).toContain("counsel-dossier")
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

		expect(provider.for("TW")).toBe(provider.for("tw"))
	})
})
