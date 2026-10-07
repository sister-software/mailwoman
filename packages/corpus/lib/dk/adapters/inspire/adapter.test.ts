/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { DatabaseClient, type RawStatements } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	type AddressGeoPackageDatabase,
	AddressGeoPackageSchemaError,
	composeUnitDesignator,
	createDKInspireAdapter,
	DK_INSPIRE_ADAPTER_ID,
	DK_INSPIRE_DEFAULT_LICENSE,
	UnresolvedAddressComponentError,
} from "#dk/adapters/inspire/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("dk-inspire")

/**
 * The committed seed: Klimadatastyrelsen's own DDL plus six of the publisher's rows.
 */
const seedSQL = workspacePath("corpus", "fixtures", "dk-inspire", "sample.sql")

/**
 * Build the fixture GeoPackage in the scratch directory from the committed SQL seed.
 *
 * The fixture is a seed rather than a committed binary so the schema a test asserts
 * against is the schema a reviewer reads in the diff.
 * The adapter reads only attribute tables, so a database carrying the publisher's DDL
 * and `gpkg_contents` is the whole of what it opens — the 391 MB file differs from this
 * one in its row count, its two unread tables and its geometry blobs.
 *
 * `mutate` runs after the seed, for the one suite that needs a reference broken.
 */
async function buildFixtureGeoPackage(at: PathBuilder, mutate?: (db: RawStatements) => void): Promise<PathBuilder> {
	const sql = await readLocalTextFile(seedSQL)

	using db = new DatabaseClient<AddressGeoPackageDatabase>(at)

	db.exec(sql)
	mutate?.(db)

	return at
}

describe("dk-inspire adapter against the fixture GeoPackage", () => {
	it("emits a row per address under the license the source register elects", async () => {
		const gpkg = await buildFixtureGeoPackage(scratch.path("ad_inspire.gpkg"))

		const manifest = await runAdapter({
			adapter: createDKInspireAdapter(),
			adapterOptions: { inputPath: gpkg },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(6)

		const rows = await readCanonicalRows(scratch.path, DK_INSPIRE_ADAPTER_ID)

		expect(rows).toHaveLength(6)
		expect(rows.every((r) => r.license === DK_INSPIRE_DEFAULT_LICENSE)).toBe(true)
		expect(rows.every((r) => r.source === DK_INSPIRE_ADAPTER_ID)).toBe(true)
		expect(rows.every((r) => r.country === "DK")).toBe(true)
		expect(rows.every((r) => r.locale === "da-DK")).toBe(true)
	})

	it("reads each component from the column and table the publisher writes it in", async () => {
		const gpkg = await buildFixtureGeoPackage(scratch.path("ad_inspire.gpkg"))

		await runAdapter({
			adapter: createDKInspireAdapter(),
			adapterOptions: { inputPath: gpkg },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await readCanonicalRows(scratch.path, DK_INSPIRE_ADAPTER_ID)

		// `locator_designator_1_designator` holds the letter, `thoroughfarename.name_name`
		// the street, and `postaldescriptor` both the postcode and the postal town.
		expect(rows[0]!.components).toEqual({
			house_number: "2A",
			street: "Nykobbelvej",
			postcode: "4200",
			locality: "Slagelse",
		})

		expect(rows[0]!.raw).toBe("Nykobbelvej 2A, 4200 Slagelse")
	})

	it("source_id uses the publisher's own inspireid", async () => {
		const gpkg = await buildFixtureGeoPackage(scratch.path("ad_inspire.gpkg"))

		await runAdapter({
			adapter: createDKInspireAdapter(),
			adapterOptions: { inputPath: gpkg },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await readCanonicalRows(scratch.path, DK_INSPIRE_ADAPTER_ID)

		expect(rows[0]!.source_id).toBe("dk-inspire-0a3f5084-5ced-32b8-e044-0003ba298018")
	})

	it("joins the floor and the door into the one unit an address line states", async () => {
		const gpkg = await buildFixtureGeoPackage(scratch.path("ad_inspire.gpkg"))

		await runAdapter({
			adapter: createDKInspireAdapter(),
			adapterOptions: { inputPath: gpkg },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await readCanonicalRows(scratch.path, DK_INSPIRE_ADAPTER_ID)
		const byRaw = new Map(rows.map((r) => [r.raw, r]))

		// A floor only, a floor with a door, and a door with no floor.
		expect(byRaw.get("Viborgvej 149 st, 8210 Aarhus V")?.components.unit).toBe("st")
		expect(byRaw.get("Knivholtvej 9 st tv, 2720 Vanløse")?.components.unit).toBe("st tv")
		expect(byRaw.get("Klosterhaven 1 6, 8620 Kjellerup")?.components.unit).toBe("6")
		expect(byRaw.get("Slagelsevej 68A tv, 4400 Kalundborg")?.components.unit).toBe("tv")
	})

	it("keeps the door of a row that carries no floor, which 967 rows of the published file do", () => {
		// The pair is joined by `composeUnitDesignator` rather than handed straight to
		// `composeHouseNumber`, which answers the empty string when its first argument is absent.
		expect(composeUnitDesignator(null, "tv")).toBe("tv")
		expect(composeUnitDesignator(null, "6")).toBe("6")
		expect(composeUnitDesignator("st", "tv")).toBe("st tv")
		expect(composeUnitDesignator("st", null)).toBe("st")
		expect(composeUnitDesignator("1", null)).toBe("1")
		expect(composeUnitDesignator(null, null)).toBe("")
	})

	it("raises on an address whose street reference resolves to no row", async () => {
		const gpkg = await buildFixtureGeoPackage(scratch.path("ad_inspire.gpkg"), (db) => {
			// Objectid 1 keeps its `component_thoroughfarename`; the row it names is removed,
			// so the reference is present and unresolvable.
			db.exec("DELETE FROM thoroughfarename WHERE inspireid = '35c543d7-daf5-4e7a-8219-f0da78f0670e'")
		})

		await expect(
			runAdapter({
				adapter: createDKInspireAdapter(),
				adapterOptions: { inputPath: gpkg },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(UnresolvedAddressComponentError)
	})

	it("names the unresolvable reference rather than yielding an address without its street", async () => {
		const gpkg = await buildFixtureGeoPackage(scratch.path("ad_inspire.gpkg"), (db) => {
			db.exec("DELETE FROM thoroughfarename WHERE inspireid = '35c543d7-daf5-4e7a-8219-f0da78f0670e'")
		})

		await expect(
			runAdapter({
				adapter: createDKInspireAdapter(),
				adapterOptions: { inputPath: gpkg },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
			// The message holds the address's own id and the column that could not be read,
			// so the failure identifies the row rather than the run.
		).rejects.toThrow(/address 0a3f5084-5ced-32b8-e044-0003ba298018 carries component_thoroughfarename=/)
	})

	it("raises on an address whose postal reference resolves to no row", async () => {
		const gpkg = await buildFixtureGeoPackage(scratch.path("ad_inspire.gpkg"), (db) => {
			db.exec("DELETE FROM postaldescriptor WHERE inspireid = '5480806a-435e-4a36-b904-a73ea8831e0d'")
		})

		await expect(
			runAdapter({
				adapter: createDKInspireAdapter(),
				adapterOptions: { inputPath: gpkg },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/carries component_postaldescriptor="5480806a-435e-4a36-b904-a73ea8831e0d"/)
	})

	it("names what it opened when the database declares none of the tables it reads", async () => {
		const other = scratch.path("not-an-address-gpkg.gpkg")

		{
			using db = new DatabaseClient<AddressGeoPackageDatabase>(other)

			db.exec(
				"CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL);" +
					"INSERT INTO gpkg_contents (table_name, data_type) VALUES ('hydro', 'features');"
			)
		}

		await expect(
			runAdapter({
				adapter: createDKInspireAdapter(),
				adapterOptions: { inputPath: other },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(AddressGeoPackageSchemaError)
	})

	it("honors opts.limit", async () => {
		const gpkg = await buildFixtureGeoPackage(scratch.path("ad_inspire.gpkg"))

		const manifest = await runAdapter({
			adapter: createDKInspireAdapter(),
			adapterOptions: { inputPath: gpkg, limit: 2 },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(2)
	})

	it("rejects a jurisdiction the dataset does not cover", async () => {
		const gpkg = await buildFixtureGeoPackage(scratch.path("ad_inspire.gpkg"))

		await expect(
			runAdapter({
				adapter: createDKInspireAdapter(),
				adapterOptions: { inputPath: gpkg, country: "GL" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/the dataset covers DK, got country=GL/)
	})

	it("accepts the one jurisdiction the dataset covers", async () => {
		const gpkg = await buildFixtureGeoPackage(scratch.path("ad_inspire.gpkg"))

		const manifest = await runAdapter({
			adapter: createDKInspireAdapter(),
			adapterOptions: { inputPath: gpkg, country: "DK" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(6)
	})

	it("two runs over the same GeoPackage produce identical sha256", async () => {
		const gpkg = await buildFixtureGeoPackage(scratch.path("ad_inspire.gpkg"))

		const a = await runAdapter({
			adapter: createDKInspireAdapter(),
			adapterOptions: { inputPath: gpkg },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		await removePathIfPresent(scratch.path(DK_INSPIRE_ADAPTER_ID))

		const b = await runAdapter({
			adapter: createDKInspireAdapter(),
			adapterOptions: { inputPath: gpkg },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(a.sha256).toBe(b.sha256)
	})
})
