// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Writes a Who's On First `metroarea` record into the `mailwoman` US admin fork for each core
 *   based statistical area: the metropolitan and micropolitan statistical areas the Office of
 *   Management and Budget delineates and the Census Bureau publishes.
 *
 *   An area is a list of whole counties. Its geometry is the union of the Who's On First county
 *   records that hold those counties' GEOIDs as `uscensus:geoid`, so it comes from boundaries the
 *   fork already holds and adds no outside one. `src:geom` is `whosonfirst`, as it is on the fork's
 *   market area records. Those are unions of counties too.
 *
 *   An area whose counties lie in one state has that state's region as its parent. An area that
 *   crosses a state line has the country as its parent and one `wof:hierarchy` branch per state.
 *   No record below an area changes: a metro area is a statistical grouping that a county's
 *   hierarchy doesn't state.
 *
 *   An area is skipped when a record already holds its code as `uscensus:cbsafp`, so a second run
 *   writes only the areas the first one didn't, and reported when a member county has no record.
 */

import { sortedGlob } from "@mailwoman/core/fs/readers"
import { nextMailwomanWOFID } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { isPresent } from "@mailwoman/core/values/objects"
import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr/stream"
import type { CBSAGazetteerEntry } from "@mailwoman/tiger/sdk/gazetteer"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { mailwomanWOFIDs, writeWOFRecord, type WOFRecordFeature } from "#tools/pipeline/wof/record"
import {
	concordancesOf,
	hierarchyOf,
	streamForkRecords,
	unionGeometries,
	type LoadedRecord,
} from "#tools/pipeline/wof/region-reform"
import { wofGeometryHash } from "#tools/pipeline/wof/slim"
import { wofRepoName } from "#whosonfirst/extract-repo"

/**
 * The concordance a metro area record holds its CBSA code under, after TIGER's `CBSAFP` column.
 *
 * A CBSA code and a county GEOID are both five digits, so the code gets a key of its own.
 */
export const CBSA_CONCORDANCE = "uscensus:cbsafp"

const GAZETTEER_URL = "https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html"
const TIGER_URL = "https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html"

/**
 * The five-digit GEOIDs of each area's counties, by CBSA code, read from a
 * TIGER/Line national county shapefile.
 * Each county row states the area it belongs to in `CBSAFP`.
 */
export async function readCBSACounties(countyShapefile: PathBuilderLike): Promise<Map<string, string[]>> {
	const layer = PathBuilder.from(countyShapefile)
		.toString()
		.replace(/^.*\//u, "")
		.replace(/\.shp$/u, "")

	const counties = new Map<string, string[]>()

	const rows = ogr2ogrGeoJSONSeq<{ properties: { GEOID: string; CBSAFP: string | null } }>(
		["-f", "GeoJSONSeq", "/vsistdout/", countyShapefile, "-sql", `SELECT GEOID, CBSAFP FROM ${layer}`, "-nlt", "NONE"],
		"TIGER county CBSA codes"
	)

	for await (const { properties } of rows) {
		if (!properties.CBSAFP) continue

		const members = counties.get(properties.CBSAFP) ?? []

		members.push(properties.GEOID)
		counties.set(properties.CBSAFP, members)
	}

	return counties
}

/**
 * Options for {@link backfillMetroAreas}.
 */
export interface MetroAreaBackfillOptions {
	/**
	 * The areas, from `readCBSAGazetteer`.
	 */
	areas: readonly CBSAGazetteerEntry[]
	/**
	 * Each area's county GEOIDs, from {@link readCBSACounties}.
	 */
	counties: ReadonlyMap<string, readonly string[]>
	/**
	 * The vintage of both Census files, for the citations.
	 */
	vintage: number
	/**
	 * The ISO 3166-1 alpha-2 code of the fork that holds the counties.
	 */
	country: string
	/**
	 * The directory that holds every WOF clone.
	 */
	reposRoot: PathBuilderLike
	/**
	 * Report the records and write no file.
	 */
	dryRun?: boolean
	/**
	 * The `wof:lastmodified` the new records take, in Unix seconds.
	 */
	lastModified: number
}

/**
 * What {@link backfillMetroAreas} did, or would do under `dryRun`.
 */
export interface MetroAreaBackfillResult {
	repoDir: string
	written: Array<{ id: number; cbsa: string; name: string; counties: number; regions: number }>
	/**
	 * Areas a record of the fork already holds by its CBSA code.
	 */
	alreadyHeld: number
	/**
	 * Areas with a county the fork holds no record of, with the GEOIDs absent.
	 */
	incomplete: Array<{ cbsa: string; name: string; absent: string[] }>
	/**
	 * Areas none of whose counties the fork holds, such as an area of another country's fork.
	 */
	elsewhere: number
}

/**
 * Writes a `metroarea` record into `options.country`'s admin fork for each
 * area whose counties the fork holds.
 */
export async function backfillMetroAreas(options: MetroAreaBackfillOptions): Promise<MetroAreaBackfillResult> {
	const reposRoot = PathBuilder.from(options.reposRoot)
	const country = options.country.toUpperCase()
	const repoName = wofRepoName("admin", country)
	const repoDir = reposRoot(repoName)
	const wanted = new Set([...options.counties.values()].flat())
	const countyRecords = new Map<string, LoadedRecord>()
	const held = new Set<string>()

	for await (const loaded of streamForkRecords(repoDir)) {
		const concordances = concordancesOf(loaded)
		const cbsa = concordances[CBSA_CONCORDANCE]

		if (typeof cbsa === "string") {
			held.add(cbsa)
		}

		const geoid = String(concordances["uscensus:geoid"] ?? "")

		if (
			loaded.feature.properties["wof:placetype"] === "county" &&
			loaded.feature.properties["mz:is_current"] !== 0 &&
			wanted.has(geoid)
		) {
			countyRecords.set(geoid, { ...loaded, text: "" })
		}
	}

	const result: MetroAreaBackfillResult = {
		repoDir: repoDir.toString(),
		written: [],
		alreadyHeld: 0,
		incomplete: [],
		elsewhere: 0,
	}

	const members = new Map<string, LoadedRecord[]>()

	for (const area of options.areas) {
		if (held.has(area.geoid)) {
			result.alreadyHeld++

			continue
		}

		const geoids = options.counties.get(area.geoid) ?? []
		const records = geoids.map((geoid) => countyRecords.get(geoid))
		const absent = geoids.filter((_, index) => !records[index])

		if (absent.length === geoids.length) {
			result.elsewhere++
		} else if (absent.length) {
			result.incomplete.push({ cbsa: area.geoid, name: area.name, absent })
		} else {
			members.set(area.geoid, records.filter(isPresent))
		}
	}

	const unions = await unionGeometries(members)
	const minted = await mailwomanWOFIDs(await sortedGlob(reposRoot, "whosonfirst-data-*", { onlyFiles: false }))
	const newRecords: WOFRecordFeature[] = []
	const gazetteer = `U.S. Census Bureau, ${options.vintage} Gazetteer file of core based statistical areas`

	for (const area of options.areas) {
		const records = members.get(area.geoid)
		const union = unions.get(area.geoid)

		if (!records || !union) continue

		const id = nextMailwomanWOFID(minted)

		minted.add(id)

		// One branch per state the area's counties lie in.
		const branches = new Map<number, Record<string, number>>()

		for (const record of records) {
			const branch = hierarchyOf(record)[0] ?? {}

			if (isPresent(branch.region_id) && !branches.has(branch.region_id)) {
				branches.set(branch.region_id, {
					...(isPresent(branch.continent_id) ? { continent_id: branch.continent_id } : {}),
					...(isPresent(branch.country_id) ? { country_id: branch.country_id } : {}),
					metroarea_id: id,
					region_id: branch.region_id,
				})
			}
		}

		const hierarchy = [...branches.values()]
		const countryID = hierarchy[0]?.country_id ?? -1
		const parentID = hierarchy.length === 1 ? hierarchy[0]!.region_id! : countryID

		const belongsTo = [...new Set(hierarchy.flatMap((branch) => Object.values(branch)))]
			.filter((other) => other !== id && other > 0)
			.toSorted((a, b) => a - b)

		const total = (key: string) => records.reduce((all, record) => all + Number(record.feature.properties[key] ?? 0), 0)

		const [longitude, latitude] = union.centroid
		const designation = area.kind === "metropolitan" ? "Metropolitan Statistical Area" : "Micropolitan Statistical Area"

		result.written.push({ id, cbsa: area.geoid, name: area.name, counties: records.length, regions: hierarchy.length })

		newRecords.push({
			id,
			type: "Feature",
			properties: {
				"edtf:cessation": "uuuu",
				"edtf:inception": "uuuu",
				"geom:area": Number(total("geom:area").toFixed(6)),
				"geom:area_square_m": total("geom:area_square_m"),
				"geom:bbox": union.bbox.join(","),
				"geom:latitude": latitude,
				"geom:longitude": longitude,
				"iso:country": country,
				"label:eng_x_preferred_longname": [area.title],
				"mailwoman:sources": [
					{
						property: "wof:placetype",
						citation: `${gazetteer}: CBSA ${area.geoid}, a ${designation} as the Office of Management and Budget delineates it.`,
						url: GAZETTEER_URL,
					},
					{ property: "wof:name", citation: `${gazetteer}: NAME "${area.title}"`, url: GAZETTEER_URL },
					{ property: "wof:concordances", citation: `${gazetteer}: GEOID ${area.geoid}`, url: GAZETTEER_URL },
					{
						property: "geometry",
						citation:
							`The union of the Who's On First county records ` +
							`${records.map((record) => `${record.feature.properties["wof:name"]} (${record.feature.id})`).join(", ")}. ` +
							`The TIGER/Line ${options.vintage} county file states CBSAFP ${area.geoid} for each of these counties.`,
						url: TIGER_URL,
					},
				],
				"mz:hierarchy_label": 0,
				"mz:is_current": 1,
				"name:eng_x_preferred": [area.name],
				"name:eng_x_variant": [area.title],
				"src:geom": "whosonfirst",
				"wof:belongsto": belongsTo,
				"wof:breaches": [],
				"wof:concordances": { [CBSA_CONCORDANCE]: area.geoid },
				"wof:country": country,
				"wof:geomhash": wofGeometryHash(union.geometry),
				"wof:hierarchy": hierarchy,
				"wof:id": id,
				"wof:lastmodified": options.lastModified,
				"wof:name": area.name,
				"wof:parent_id": parentID,
				"wof:placetype": "metroarea",
				"wof:placetype_local": designation,
				"wof:repo": repoName,
				"wof:superseded_by": [],
				"wof:supersedes": [],
				"wof:tags": [],
			},
			bbox: union.bbox,
			geometry: union.geometry,
		})
	}

	if (!options.dryRun) {
		for (const record of newRecords) {
			await writeWOFRecord(repoDir, record)
		}
	}

	return result
}
