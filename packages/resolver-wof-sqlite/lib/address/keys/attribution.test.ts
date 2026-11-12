// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { LayerFreshnessPolicy, LayerTier } from "@mailwoman/core/layers"
import { describe, expect, it } from "vitest"

import { type AddressLayerAttribution, writeAddressLayerAttribution } from "#address/keys/attribution"
import { buildAddressLayer } from "#address/keys/build"
import { addressLayerFiles } from "#address/keys/layout"
import type { AddressRecord } from "#address/record"
import { canonicalizeRouteKey, normalizeStreetForKey } from "#street/normalize"

function record(source: string, authority: string | null, number: string): AddressRecord {
	const streetKey = normalizeStreetForKey("Main Street")

	return {
		source,
		sourceRecordID: `${source}-${number}`,
		country: "US",
		subdivision: "US-WI",
		number,
		unit: null,
		streetRaw: "Main Street",
		streetKey,
		routeKey: canonicalizeRouteKey(streetKey),
		postcode: "53202",
		names: [],
		adminCode: null,
		lat: 43.04,
		lon: -87.9,
		placement: null,
		authority,
	}
}

async function* stream(records: AddressRecord[]) {
	yield* records
}

describe("writeAddressLayerAttribution", () => {
	it("tallies a region's rows by source and authority, with each source's license and recorded terms", async () => {
		await using dir = await temporaryDirectory("address-attribution-")
		const files = addressLayerFiles(dir.path(), "us-wi", "test")
		const runTerms = { text: "Public Domain", attribution: false }

		await buildAddressLayer({
			records: stream([
				record("usgov-nad", "co.adams.wi.us", "1"),
				record("usgov-nad", "co.adams.wi.us", "2"),
				record("usgov-nad", "co.dane.wi.us", "3"),
				record("openaddresses:us/wi/statewide", null, "4"),
			]),
			sources: new Map([
				["usgov-nad", { license: "public-domain", authority: "U.S. Department of Transportation" }],
				["openaddresses:us/wi/statewide", { license: null, authority: null }],
			]),
			manifest: {
				name: "addresses-us-wi",
				version: "test",
				tier: LayerTier.Shipped,
				license: "CC0-1.0",
				attribution: null,
				source: "fixture",
				sourceVintage: "test",
				buildCmd: "vitest",
				buildSHA: "0000000",
				freshnessPolicy: LayerFreshnessPolicy.Sealed,
				createdAt: "2026-11-08T00:00:00Z",
			},
			lookupPath: files.lookup,
			detailPath: files.detail,
		})

		const { path, entries } = await writeAddressLayerAttribution(
			dir.path(),
			"us-wi",
			"test",
			new Map([["openaddresses:us/wi/statewide", runTerms]])
		)

		const expected: AddressLayerAttribution[] = [
			{ source: "usgov-nad", authority: "co.adams.wi.us", records: 2, license: "public-domain", recorded: null },
			{ source: "usgov-nad", authority: "co.dane.wi.us", records: 1, license: "public-domain", recorded: null },
			{ source: "openaddresses:us/wi/statewide", authority: null, records: 1, license: null, recorded: runTerms },
		]

		expect(entries).toEqual(expected)
		expect(await readLocalJSONFile(path)).toEqual(expected)
		expect(path.toString()).toBe(dir.path("addresses", "us-wi", "test", "ATTRIBUTION.json").toString())
	})

	it("folds a source whose authority values each name one record into one entry, and counts them", async () => {
		await using dir = await temporaryDirectory("address-attribution-ids-")
		const files = addressLayerFiles(dir.path(), "us-id", "test")

		await buildAddressLayer({
			records: stream([
				record("usgov-nad", "13000255", "1"),
				record("usgov-nad", "13000256", "2"),
				record("usgov-nad", "13000257", "3"),
			]),
			sources: new Map([["usgov-nad", { license: "public-domain", authority: "U.S. Department of Transportation" }]]),
			manifest: {
				name: "addresses-us-id",
				version: "test",
				tier: LayerTier.Shipped,
				license: "CC0-1.0",
				attribution: null,
				source: "fixture",
				sourceVintage: "test",
				buildCmd: "vitest",
				buildSHA: "0000000",
				freshnessPolicy: LayerFreshnessPolicy.Sealed,
				createdAt: "2026-11-08T00:00:00Z",
			},
			lookupPath: files.lookup,
			detailPath: files.detail,
		})

		const { entries } = await writeAddressLayerAttribution(dir.path(), "us-id", "test")

		expect(entries).toEqual([
			{
				source: "usgov-nad",
				authority: null,
				records: 3,
				license: "public-domain",
				recorded: null,
				omittedAuthorities: 3,
			},
		])
	})
})
