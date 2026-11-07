/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { parseJSONStrict } from "@mailwoman/core/json"
import { LayerFreshnessPolicy, LayerTier, readLayerCoverage, readLayerManifest } from "@mailwoman/core/layers"
import { shortCellToInt } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { latLngToCell } from "@sister.software/h3"
import { describe, expect, it } from "vitest"

import { ADDRESS_LAYER_COVERAGE_RESOLUTION, type AddressLayerManifest, buildAddressLayer } from "#address/keys/build"
import { addressPostcodeKey } from "#address/keys/postcode"
import type { AddressDetailDatabase, AddressLookupDatabase } from "#address/keys/schema"
import { AddressNameForm, type AddressRecord } from "#address/record"
import { canonicalizeRouteKey, normalizeLocalityForKey, normalizeStreetForKey } from "#street/normalize"

function record(overrides: Partial<AddressRecord> & Pick<AddressRecord, "number" | "streetRaw">): AddressRecord {
	const streetKey = normalizeStreetForKey(overrides.streetRaw)

	const name = (level: "locality" | "subregion" | "region", form: AddressNameForm, value: string) => ({
		level,
		form,
		value,
		key: normalizeLocalityForKey(value),
	})

	return {
		source: "usgov-nad",
		sourceRecordID: `nad-${overrides.number}`,
		country: "US",
		unit: null,
		streetKey,
		routeKey: canonicalizeRouteKey(streetKey),
		postcode: "53211",
		names: [
			name("region", AddressNameForm.Written, "WI"),
			name("subregion", AddressNameForm.Written, "Milwaukee"),
			name("locality", AddressNameForm.Written, "City of Milwaukee"),
			name("locality", AddressNameForm.Bare, "Milwaukee"),
		],
		adminCode: null,
		lat: 43.07,
		lon: -87.88,
		placement: "Structure - Rooftop",
		authority: "milwaukee.gov",
		...overrides,
	}
}

async function* stream(records: AddressRecord[]) {
	yield* records
}

const MANIFEST: AddressLayerManifest = {
	name: "addresses-us-wi",
	version: "2026-11-07",
	tier: LayerTier.Shipped,
	license: "CC0-1.0",
	attribution: null,
	source: "fixture",
	sourceVintage: "2026-11-07",
	buildCmd: "vitest",
	buildSHA: "0000000",
	freshnessPolicy: LayerFreshnessPolicy.Sealed,
	createdAt: "2026-11-07T00:00:00Z",
}

describe("addressPostcodeKey", () => {
	it("reduces a US ZIP+4 to its ZIP Code and compacts every other country's postcode", () => {
		expect(addressPostcodeKey("US", "53221-3633")).toBe("53221")
		expect(addressPostcodeKey("us", "532213633")).toBe("53221")
		expect(addressPostcodeKey("GB", "bs4 5aa")).toBe("BS45AA")
		expect(addressPostcodeKey("FR", " 75003 ")).toBe("75003")
		expect(addressPostcodeKey("US", "  ")).toBeNull()
	})
})

describe("buildAddressLayer", () => {
	it("writes one key row per level and locality form, and every record's detail", async () => {
		await using dir = await temporaryDirectory("address-layer-")

		const records = [
			record({ number: "3200", streetRaw: "N Downer Ave" }),
			record({ number: "3203", streetRaw: "N Downer Ave", postcode: "53211-1234" }),
			record({ number: "10", streetRaw: "Main St", postcode: null, source: "openaddresses:us/wi/statewide" }),
		]

		const summary = await buildAddressLayer({
			records: stream(records),
			sources: new Map([
				["usgov-nad", { license: "public-domain", authority: "US DOT" }],
				["openaddresses:us/wi/statewide", { license: null, authority: null }],
			]),
			manifest: MANIFEST,
			lookupPath: dir.path("lookup.db"),
			detailPath: dir.path("detail.db"),
		})

		expect(summary).toMatchObject({
			records: 3,
			keys: { key_postcode: 2, key_locality: 6, key_subregion: 3, key_region: 3 },
			sources: { "usgov-nad": 2, "openaddresses:us/wi/statewide": 1 },
			localityFormsPerRecord: 2,
		})

		using lookup = new DatabaseClient<AddressLookupDatabase>(dir.path("lookup.db"), { readOnly: true })

		const downer = await lookup
			.selectFrom("key_postcode")
			.selectAll()
			.where("scope", "=", "53211")
			.where("street", "=", normalizeStreetForKey("N Downer Ave"))
			.orderBy("number")
			.execute()

		expect(downer.map((row) => row.number)).toEqual(["3200", "3203"])

		const bare = await lookup
			.selectFrom("key_locality")
			.select("number")
			.where("scope", "=", normalizeLocalityForKey("Milwaukee"))
			.execute()

		expect(bare).toHaveLength(3)

		const sources = await lookup.selectFrom("source").selectAll().orderBy("source_id").execute()

		expect(sources.map(({ name, records: count }) => `${name}:${count}`)).toEqual([
			"usgov-nad:2",
			"openaddresses:us/wi/statewide:1",
		])

		const street = await lookup.selectFrom("street_postcode").selectAll().executeTakeFirstOrThrow()

		expect(street.points).toBe(2)

		using detail = new DatabaseClient<AddressDetailDatabase>(dir.path("detail.db"), { readOnly: true })

		const main = await detail.selectFrom("address").selectAll().where("number", "=", "10").executeTakeFirstOrThrow()

		expect(main).toMatchObject({ postcode: null, street_raw: "Main St", authority: "milwaukee.gov" })
		expect(parseJSONStrict<unknown[]>(main.names)).toHaveLength(4)

		const pageSize = lookup.prepare("PRAGMA page_size").get() as { page_size: number }

		expect(pageSize.page_size).toBe(8192)

		const manifest = await readLayerManifest(lookup)

		expect(manifest).toMatchObject({
			name: "addresses-us-wi",
			sourceRecords: { "usgov-nad": 2, "openaddresses:us/wi/statewide": 1 },
		})

		const cell = shortCellToInt(latLngToCell(43.07, -87.88, ADDRESS_LAYER_COVERAGE_RESOLUTION))

		expect(await readLayerCoverage(lookup, cell)).toMatchObject({ observedRows: 3, basis: "source_present" })
	})

	it("refuses a record whose source the build lists no terms for", async () => {
		await using dir = await temporaryDirectory("address-layer-")

		await expect(
			buildAddressLayer({
				records: stream([record({ number: "1", streetRaw: "Elm St", source: "unlisted" })]),
				sources: new Map(),
				manifest: MANIFEST,
				lookupPath: dir.path("lookup.db"),
				detailPath: dir.path("detail.db"),
			})
		).rejects.toThrow(/lists no terms for/)
	})
})
