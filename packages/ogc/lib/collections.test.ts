// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { AddressPointLookup, RegionDatabases } from "@mailwoman/core/resolver"
import { expect, test } from "vitest"

import { OGCCollectionID, servedCollections } from "#index"

test("addresses list the regions with an opened layer, and streets are left out when no region has one", () => {
	const opened: Record<string, RegionDatabases> = { tx: { addressPoints: {} as AddressPointLookup } }

	const served = servedCollections(
		[
			{
				provider: { for: (key) => opened[key] ?? {} },
				keys: ["ak", "tx"],
				regionOf: (key) => `US-${key.toUpperCase()}`,
			},
		],
		{ postcodes: true }
	)

	expect(served).toEqual([
		{ id: OGCCollectionID.Addresses, regions: ["US-TX"] },
		{ id: OGCCollectionID.Postcodes, regions: null },
		{ id: OGCCollectionID.Places, regions: null },
		{ id: OGCCollectionID.PlusCodes, regions: null },
	])
})

test("postcodes are left out when the gazetteer holds no postcode places", () => {
	expect(servedCollections([], { postcodes: false }).map(({ id }) => id)).toEqual([
		OGCCollectionID.Places,
		OGCCollectionID.PlusCodes,
	])
})
