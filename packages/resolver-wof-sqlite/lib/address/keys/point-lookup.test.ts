// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { LayerFreshnessPolicy, LayerTier } from "@mailwoman/core/layers"
import { describe, expect, it } from "vitest"

import { buildAddressLayer } from "#address/keys/build"
import { openAddressLayerLookup } from "#address/keys/open"
import { AddressNameForm, type AddressRecord } from "#address/record"
import { canonicalizeRouteKey, normalizeLocalityForKey, normalizeStreetForKey } from "#street/normalize"

function record(number: string, postcode: string | null, locality: string | null, lat: number): AddressRecord {
	const streetKey = normalizeStreetForKey("Main St")

	return {
		source: "usgov-nad",
		sourceRecordID: `nad-${number}-${lat}`,
		country: "US",
		subdivision: "US-WI",
		number,
		unit: null,
		streetRaw: "Main St",
		streetKey,
		routeKey: canonicalizeRouteKey(streetKey),
		postcode,
		names: locality
			? [{ level: "locality", form: AddressNameForm.Written, value: locality, key: normalizeLocalityForKey(locality) }]
			: [],
		adminCode: null,
		lat,
		lon: -88,
		placement: null,
		authority: null,
	}
}

async function* stream(records: AddressRecord[]) {
	yield* records
}

describe("openAddressLayerLookup", () => {
	it("answers the resolver's address-point query with the source name and layer version", async () => {
		await using dir = await temporaryDirectory("address-point-lookup-")

		await buildAddressLayer({
			records: stream([
				record("10", "53001", "Adell", 43.6),
				record("10", null, "Allenton", 43.4),
				record("10", null, null, 43.45),
			]),
			sources: new Map([["usgov-nad", { license: "public-domain", authority: null }]]),
			manifest: {
				name: "addresses-us-wi",
				version: "2026-11-07",
				tier: LayerTier.Shipped,
				license: "CC0-1.0",
				attribution: null,
				source: "fixture",
				sourceVintage: "test",
				buildCmd: "vitest",
				buildSHA: "0000000",
				freshnessPolicy: LayerFreshnessPolicy.Sealed,
				createdAt: "2026-11-07T00:00:00Z",
			},
			lookupPath: dir.path("lookup.db"),
			detailPath: dir.path("detail.db"),
		})

		using lookup = openAddressLayerLookup(dir.path("lookup.db"), "US")

		expect(await lookup.find({ street: "Main Street", number: "10", postcode: "53001", bbox: null })).toEqual({
			lat: 43.6,
			lon: -88,
			source: "usgov-nad",
			release: "2026-11-07",
			localityNorm: null,
			postcode: "53001",
		})

		expect(await lookup.find({ street: "Main St", number: "10", locality: "Allenton", bbox: null })).toMatchObject({
			lat: 43.4,
		})

		// A query that states a street and number and no place answers only inside the resolver's box.
		expect(await lookup.find({ street: "Main St", number: "10", bbox: null })).toBeNull()

		// Inside the box, the Allenton row states a locality, so it would have matched its own scope.
		// The row that states neither a postcode nor a locality answers.
		expect(
			await lookup.find({
				street: "Main St",
				number: "10",
				bbox: { minLat: 43.3, maxLat: 43.5, minLon: -89, maxLon: -87 },
			})
		).toMatchObject({ lat: 43.45 })

		expect(
			await lookup.find({
				street: "Main St",
				number: "10",
				bbox: { minLat: 43.35, maxLat: 43.42, minLon: -89, maxLon: -87 },
			})
		).toBeNull()
	})
})
