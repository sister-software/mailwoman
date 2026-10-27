/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A second walk of unchanged WOF files reads the cache, and an edited file gives a new cache key.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { expect, test } from "vitest"

import { walkFeaturesCached, wofRecordCachePath } from "#adapters/wof/record-cache"
import { useScratchDir } from "#test-kit"
import { walkFeatures } from "#utils/wof-json"

const scratch = useScratchDir("wof-record-cache")

const feature = (id: number, name: string) => ({
	type: "Feature",
	id,
	properties: {
		"wof:id": id,
		"wof:name": name,
		"wof:placetype": "locality",
		"wof:country": "US",
		"wof:parent_id": 85_688_637,
		"mz:is_current": 1,
		"geom:latitude": 40.65,
		"geom:longitude": -73.95,
		"name:fra_x_preferred": [`${name} (fr)`],
		"wof:hierarchy": [{ locality_id: id, region_id: 85_688_543, country_id: 85_633_793 }],
	},
	geometry: { type: "Point", coordinates: [-73.95, 40.65] },
})

test("walkFeaturesCached yields the walk's records, then the same records from the cache, until a file changes", async () => {
	const repo = scratch.path("repo")
	const cache = scratch.path("cache")

	await writeLocalJSONFile(feature(1, "Brooklyn"), repo, "data/1.geojson")
	await writeLocalJSONFile(feature(2, "Queens"), repo, "data/2.geojson")

	const walked = await Array.fromAsync(walkFeatures(repo))

	expect(walked.map((record) => record.name)).toEqual(["Brooklyn", "Queens"])

	const first = await Array.fromAsync(walkFeaturesCached(repo, { cacheDir: cache }))
	const cacheFile = await wofRecordCachePath(repo, cache)

	expect(first).toEqual(walked)
	expect(await pathExists(cacheFile)).toBe(true)

	const second = await Array.fromAsync(walkFeaturesCached(repo, { cacheDir: cache }))

	expect(second).toEqual(walked)
	expect(second[0]!.nameVariants).toBeInstanceOf(Map)

	await writeLocalJSONFile(feature(2, "Queens County"), repo, "data/2.geojson")

	expect(await wofRecordCachePath(repo, cache)).not.toBe(cacheFile)
	expect((await Array.fromAsync(walkFeaturesCached(repo, { cacheDir: cache })))[1]!.name).toBe("Queens County")
})
