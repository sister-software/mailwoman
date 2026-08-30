import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { readLayerCoverage, readLayerManifest, writeLayerManifest } from "@mailwoman/core/layers"
import {
	createOSMAddressPointIndexes,
	createOSMAddressPointTables,
	OSM_ADDRESS_H3_RESOLUTION,
	type OSMAddressPointDatabase,
} from "@mailwoman/osm/sdk/address-point-schema"
import { normalizeStreetForKeyLocale } from "@mailwoman/osm/sdk/street-locale"
import { join } from "@mailwoman/platform/path"
import { AddressPointSqliteLookup } from "@mailwoman/resolver-wof-sqlite"
import { canonicalizeRouteKey, normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

describe("OSM address-point layer schema", () => {
	it("adds an indexed H3 spine and honest empty coverage to the shared rooftop table", async () => {
		using db = DatabaseClient.temp<OSMAddressPointDatabase>()

		await createOSMAddressPointTables(db)

		const street = "Dollis Park"
		const streetNorm = normalizeStreetForKeyLocale(street, "en")

		await db
			.insertInto("address_point")
			.values({
				street_norm: streetNorm,
				street_key: canonicalizeRouteKey(streetNorm),
				number: "2",
				unit: null,
				postcode: "N3 1HF",
				locality_norm: normalizeLocalityForKey("London"),
				street_raw: street,
				lat: 51.599,
				lon: -0.194,
				source: "openstreetmap:gb",
				release: "fixture",
				h3_cell: 123_456,
			})
			.execute()

		await createOSMAddressPointIndexes(db)

		await writeLayerManifest(db, {
			name: "osm-address-points-gb-test",
			version: "fixture",
			schemaVersion: 1,
			tier: "build-local",
			license: "ODbL-1.0",
			attribution: "© OpenStreetMap contributors",
			source: "openstreetmap:gb",
			sourceVintage: "fixture",
			buildCmd: "fixture",
			buildSHA: "test",
			freshnessPolicy: "sealed",
			spineKeys: { h3: { column: "h3_cell", resolution: OSM_ADDRESS_H3_RESOLUTION } },
			createdAt: "2026-08-09T00:00:00.000Z",
		})

		const manifest = await readLayerManifest(db)
		expect(manifest.spineKeys).toEqual({ h3: { column: "h3_cell", resolution: 9 } })
		expect(await readLayerCoverage(db, 123_456)).toBeUndefined()

		const columns = db.prepare("PRAGMA table_info(address_point)").all() as Array<{ name: string; notnull: number }>
		expect(columns.find((column) => column.name === "h3_cell")?.notnull).toBe(1)
		const indexes = db.prepare("PRAGMA index_list(address_point)").all() as Array<{ name: string }>
		expect(indexes.some((index) => index.name === "idx_ap_h3")).toBe(true)
	})

	it("remains readable through the unchanged shared address-point lookup", async () => {
		await using dirDirectory = await temporaryDirectory("mailwoman-osm-address-schema-")
		const dir = dirDirectory.path
		const path = join(dir, "address-points-fr.db")

		try {
			using db = new DatabaseClient<OSMAddressPointDatabase>(path)
			await createOSMAddressPointTables(db)
			const street = "Rue de Rivoli"
			const streetNorm = normalizeStreetForKeyLocale(street, "fr")

			await db
				.insertInto("address_point")
				.values({
					street_norm: streetNorm,
					street_key: canonicalizeRouteKey(streetNorm),
					number: "2",
					unit: null,
					postcode: "75001",
					locality_norm: normalizeLocalityForKey("Paris"),
					street_raw: street,
					lat: 48.8566,
					lon: 2.3522,
					source: "openstreetmap:fr",
					release: "fixture",
					h3_cell: 123_456,
				})
				.execute()

			using lookup = new AddressPointSqliteLookup(path, { streetLocale: "fr" })

			expect(lookup.find({ street, number: "2", postcode: "75001" })).toMatchObject({
				lat: 48.8566,
				lon: 2.3522,
				source: "openstreetmap:fr",
			})
		} finally {
		}
	})
})
