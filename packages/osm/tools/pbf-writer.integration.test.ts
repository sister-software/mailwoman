/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   GDAL's OSM driver reads back every node `writePBF` wrote, with its address tags and its coordinate.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalBuffer } from "@mailwoman/core/fs/writers"
import { expect, it } from "vitest"

import { extractAddrPoints } from "#sdk/extract"
import { writePBF } from "#tools/pbf-writer"

it("writes a PBF whose address nodes the extractor reads back", async () => {
	await using directory = await temporaryDirectory("mw-pbf-writer-")

	const path = directory.path("fixture.osm.pbf").toString()

	await writeLocalBuffer(
		writePBF([
			{
				id: 2,
				lat: 52.5163,
				lon: 13.3807,
				tags: { "addr:housenumber": "77", "addr:street": "Unter den Linden", "addr:postcode": "10117" },
			},
			{ id: 1, lat: 48.2085, lon: 16.3731, tags: { "addr:housenumber": "1", "addr:street": "Stephansplatz" } },
			{ id: 3, lat: 52.52, lon: 13.4, tags: { amenity: "bench" } },
		]),
		path
	)

	const records = await Array.fromAsync(extractAddrPoints(path))

	expect(records.map((record) => [record.street, record.housenumber, record.postcode])).toEqual([
		["Stephansplatz", "1", null],
		["Unter den Linden", "77", "10117"],
	])

	expect(records[1]!.lat).toBeCloseTo(52.5163, 6)
	expect(records[1]!.lon).toBeCloseTo(13.3807, 6)
})
