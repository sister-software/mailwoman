/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The London fixture's flood records against the host's `flood.db`. The suite skips when the
 *   database is absent from the data root.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { FloodZoneLookup } from "@mailwoman/flood"
import { floodLayerReading } from "@mailwoman/flood/layer-readings"
import { floodDatabasePath } from "@mailwoman/flood/paths"
import { describe, expect, test } from "vitest"

import {
	FLOOD_LAYER,
	FLOOD_MAP,
	FLOOD_VINTAGE,
	LONDON_RECORDS,
	LONDON_SITES,
	siteFloodRecords,
	sitePosition,
} from "#test/fixtures/london-three-buildings"

const DATABASE = floodDatabasePath("flood.db")

describe.skipIf(!(await pathExists(DATABASE)))("the London flood records against flood.db", () => {
	test("the flood map's source record takes its layer and dates from the database manifest", () => {
		using lookup = new FloodZoneLookup({ databasePath: DATABASE })

		const { manifest } = lookup.identity

		expect([manifest.name, manifest.sourceVintage]).toEqual([FLOOD_LAYER, FLOOD_VINTAGE])

		expect(LONDON_RECORDS.sources.find((source) => source.id === FLOOD_MAP)).toMatchObject({
			observedAt: manifest.sourceVintage,
			availableAt: manifest.sourceVintage,
			retrievedAt: manifest.createdAt,
		})
	})

	test("floodLayerReading at each building's position returns the reading and claim the fixture stores", () => {
		using lookup = new FloodZoneLookup({ databasePath: DATABASE })

		for (const site of LONDON_SITES) {
			const { latitude, longitude } = sitePosition(site)

			expect(floodLayerReading(lookup, { subject: site.building, latitude, longitude, source: FLOOD_MAP })).toEqual(
				siteFloodRecords(site)
			)
		}
	})
})
