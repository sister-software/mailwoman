// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

import type { AddressRecord } from "#address/record"
import { OUTSIDE_SUBDIVISION, openSubdivisionBoundsCheck } from "#address/subdivision-bounds"
import { canonicalizeRouteKey, normalizeStreetForKey } from "#street/normalize"

function at(subdivision: string | null, lat: number, lon: number): AddressRecord {
	return {
		source: "openaddresses:us/md/statewide",
		sourceRecordID: `${lat},${lon}`,
		country: "US",
		subdivision,
		number: "1",
		unit: null,
		streetRaw: "Main Street",
		streetKey: normalizeStreetForKey("Main Street"),
		routeKey: canonicalizeRouteKey(normalizeStreetForKey("Main Street")),
		postcode: null,
		names: [],
		adminCode: null,
		lat,
		lon,
		placement: null,
		authority: null,
	}
}

describe("openSubdivisionBoundsCheck", () => {
	it("refuses a point outside its stated subdivision's box and keeps one inside or unchecked", async () => {
		await using dir = await temporaryDirectory("subdivision-bounds-")
		const path = dir.path("admin.db")

		{
			using db = new DatabaseClient<unknown>(path)

			db.exec(`CREATE TABLE spr (id INTEGER PRIMARY KEY, placetype TEXT, is_current INTEGER,
				min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL)`)

			db.exec("CREATE TABLE concordances (id INTEGER, other_id TEXT, other_source TEXT)")
			// Maryland's Who's On First box, 85688501.
			db.exec("INSERT INTO spr VALUES (85688501, 'region', 1, 37.886605, 39.723037, -79.487651, -74.986282)")
			db.exec("INSERT INTO concordances VALUES (85688501, 'US-MD', 'iso:code')")
		}

		using check = openSubdivisionBoundsCheck(path)

		// The point 10,525 `openaddresses:us/md/statewide` addresses share lies in West Virginia.
		expect(check.refuse(at("US-MD", 37.57726, -81.52919))).toBe(OUTSIDE_SUBDIVISION)
		expect(check.refuse(at("US-MD", 38.9784, -76.4922))).toBeNull()
		expect(check.refuse(at(null, -90, -87.08333))).toBeNull()
		expect(check.refuse(at("US-IN", -90, -87.08333))).toBeNull()
		expect([...check.unchecked]).toEqual(["US-IN"])
	})
})
