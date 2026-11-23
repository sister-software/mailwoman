// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Tests what the region provider answers for a region with data, a region without, and a file it can't read.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import type { AddressPointLookup, InterpolationLookup } from "@mailwoman/core/resolver"
import type { AddressLayerCountryManifest } from "@mailwoman/resolver-wof-sqlite/address/keys/layout"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import {
	addressLayerSource,
	type AddressLayerFactory,
	type RegionFileSource,
	SubdivisionDatabaseProvider,
} from "#geocode/layers/regions"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

interface OpenedLookup extends AddressPointLookup, Disposable {
	path: string
	country: string
	closed: boolean
}

function openedLookup(path: string, country: string): OpenedLookup {
	return {
		path,
		country,
		closed: false,
		find: () => null,
		[Symbol.dispose]() {
			this.closed = true
		},
	}
}

function manifestOf(
	country: string,
	regions: Array<{ region: string; subdivision: string | null }>
): AddressLayerCountryManifest {
	const file = (region: string, name: string) => ({
		path: `addresses/${region}/2026-11-21/${name}`,
		bytes: 0,
		sha256: "",
	})

	return {
		country,
		version: "2026-11-21",
		splitRows: 10_000_000,
		regions: regions.map(({ region, subdivision }) => ({
			region,
			subdivision,
			records: 1,
			lookup: file(region, "lookup.db"),
			detail: file(region, "detail.db"),
		})),
	}
}

/**
 * A data root whose address layer holds a `lookup.db` for each region in `regions`.
 */
async function dataRootWith(regions: readonly string[]): Promise<PathBuilder> {
	const root = fixtures.use(await temporaryDirectory("mw-regions-")).path

	for (const region of regions) {
		await writeLocalTextFile("", root("db", "addresses", region, "2026-11-21", "lookup.db"))
	}

	return root
}

function factoryOf(manifests: AddressLayerCountryManifest[]): AddressLayerFactory {
	return { openAddressLayerLookup: openedLookup, readLatestAddressLayerManifests: async () => manifests }
}

describe("SubdivisionDatabaseProvider over the address layer", () => {
	it("serves any country a manifest lists, by ISO 3166-2 code, and a whole-country file by its country code", async () => {
		const root = await dataRootWith(["us-wi", "fr-75", "tw"])

		const manifests = [
			manifestOf("FR", [{ region: "fr-75", subdivision: "FR-75" }]),
			manifestOf("TW", [{ region: "tw", subdivision: null }]),
			manifestOf("US", [{ region: "us-wi", subdivision: "US-WI" }]),
		]

		using provider = await SubdivisionDatabaseProvider.create([addressLayerSource(factoryOf(manifests), root)])

		expect(provider.regions()).toEqual(["FR-75", "TW", "US-WI"])

		for (const [key, country] of [
			["US-WI", "US"],
			["fr-75", "FR"],
			["TW", "TW"],
		] as const) {
			expect(provider.for(key).addressPoints).toMatchObject({ country })
		}

		expect(provider.layerDatabases("FR-75")).toEqual([
			{
				tier: "addressPoints",
				path: root("db", "addresses", "fr-75", "2026-11-21", "lookup.db").toString(),
				sourceLocations: {},
			},
		])
	})

	it("answers an empty bundle for a country with no manifest, a region its manifest leaves out, and a null code", async () => {
		const root = await dataRootWith(["us-wi"])
		const source = addressLayerSource(factoryOf([manifestOf("US", [{ region: "us-wi", subdivision: "US-WI" }])]), root)

		using provider = await SubdivisionDatabaseProvider.create([source])

		expect(provider.for("DE-BY")).toEqual({ addressPoints: null, interpolation: null })
		expect(provider.for("US-TX")).toEqual({ addressPoints: null, interpolation: null })
		expect(provider.for(null)).toEqual({})
		expect(provider.layerDatabases("US-TX")).toEqual([])

		using empty = await SubdivisionDatabaseProvider.create([addressLayerSource(factoryOf([]), root)])

		expect(empty.regions()).toEqual([])
	})

	it("throws for a region whose listed file isn't on disk, where an absent region answers an empty bundle", async () => {
		const root = await dataRootWith([])
		const source = addressLayerSource(factoryOf([manifestOf("US", [{ region: "us-wi", subdivision: "US-WI" }])]), root)

		using provider = await SubdivisionDatabaseProvider.create([source])

		expect(provider.regions()).toEqual(["US-WI"])
		expect(() => provider.for("US-WI")).toThrow(/lists .*lookup\.db for us-wi, and the file doesn't exist/u)
	})

	it("rejects at construction when a manifest can't be read", async () => {
		const unreadable: AddressLayerFactory = {
			openAddressLayerLookup: openedLookup,
			readLatestAddressLayerManifests: async () => {
				throw new SyntaxError("Unexpected end of JSON input")
			},
		}

		await expect(
			SubdivisionDatabaseProvider.create([addressLayerSource(unreadable, await dataRootWith([]))])
		).rejects.toThrow("Unexpected end of JSON input")
	})

	it("reads each tier from the first source that lists the region, and closes what it opened", async () => {
		const root = await dataRootWith(["us-wi"])
		const older = openedLookup("address-points-us-wi.db", "US")
		const olderTexas = openedLookup("address-points-us-tx.db", "US")

		const interpolation: InterpolationLookup & Disposable = {
			radiusCalibration: null,
			find: () => null,
			[Symbol.dispose]() {},
		}

		const olderFiles: RegionFileSource = {
			tier: "addressPoints",
			locate: async () =>
				new Map([
					["US-WI", { path: older.path, open: () => older }],
					["US-TX", { path: olderTexas.path, open: () => olderTexas }],
				]),
		}

		const interpolationFiles: RegionFileSource = {
			tier: "interpolation",
			locate: async () => new Map([["US-WI", { path: "interpolation-us-wi.db", open: () => interpolation }]]),
		}

		const layer = addressLayerSource(factoryOf([manifestOf("US", [{ region: "us-wi", subdivision: "US-WI" }])]), root)
		const provider = await SubdivisionDatabaseProvider.create([layer, olderFiles, interpolationFiles])
		const wisconsin = provider.for("US-WI")

		// The address layer lists Wisconsin, so its file outranks the older one.
		// The older file is never opened.
		expect(wisconsin.addressPoints).toMatchObject({
			path: root("db", "addresses", "us-wi", "2026-11-21", "lookup.db").toString(),
		})

		expect(wisconsin.interpolation).toBe(interpolation)
		expect(provider.for("US-TX").addressPoints).toBe(olderTexas)
		expect(provider.for("US-WI").addressPoints).toBe(wisconsin.addressPoints)

		provider[Symbol.dispose]()

		expect(wisconsin.addressPoints).toMatchObject({ closed: true })
		expect(olderTexas.closed).toBe(true)
		expect(older.closed).toBe(false)
	})
})
