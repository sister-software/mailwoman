// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Writes a Who's On First `county` record into the `mailwoman` US admin fork for each county
 *   equivalent of one state that the Census Bureau lists and the fork holds no record of.
 *
 *   Connecticut is the case this serves. Since 2022 the Census Bureau reports Connecticut by nine
 *   planning regions in place of its eight counties, and every later Census product, the core
 *   based statistical areas among them, states the planning region's GEOID.
 *
 *   A county equivalent is a list of whole county subdivisions. Its geometry is the union of the
 *   fork's `localadmin` records for those subdivisions, so it comes from boundaries the fork
 *   already holds. A subdivision's GEOID is its state, county and subdivision codes. The
 *   subdivision code is the same under the former county and the new one, so a town record joins
 *   by its state code and its last five digits.
 *
 *   No existing record changes. The former counties stay current, because the Census Bureau
 *   replaced them as statistical units only, and a town's hierarchy keeps the county it states.
 */

import { sortedGlob } from "@mailwoman/core/fs/readers"
import { nextMailwomanWOFID } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { isPresent } from "@mailwoman/core/values/objects"
import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr/stream"
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

const TIGER_URL = "https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html"
const GAZETTEER_URL = "https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html"

/**
 * The digits of a county subdivision's own code, the last five of its ten-digit GEOID.
 */
const SUBDIVISION_CODE_DIGITS = 5

/**
 * One county or county equivalent of the TIGER/Line national county file.
 */
export interface TIGERCounty {
	/**
	 * The five-digit state and county code, `09110`.
	 */
	geoid: string
	/**
	 * The name without its legal description, `Capitol`.
	 */
	name: string
	/**
	 * The name with its legal description, `Capitol Planning Region`.
	 */
	title: string
}

/**
 * The counties and county equivalents of one state, read from a TIGER/Line national county shapefile.
 */
export async function readTIGERCounties(countyShapefile: PathBuilderLike, stateFIPS: string): Promise<TIGERCounty[]> {
	const layer = PathBuilder.from(countyShapefile)
		.toString()
		.replace(/^.*\//u, "")
		.replace(/\.shp$/u, "")

	if (!/^\d{2}$/u.test(stateFIPS)) throw new Error(`a state FIPS code is two digits: ${stateFIPS}`)

	const rows = ogr2ogrGeoJSONSeq<{ properties: { GEOID: string; NAME: string; NAMELSAD: string } }>(
		[
			"-f",
			"GeoJSONSeq",
			"/vsistdout/",
			countyShapefile,
			"-sql",
			`SELECT GEOID, NAME, NAMELSAD FROM ${layer} WHERE STATEFP = '${stateFIPS}'`,
			"-nlt",
			"NONE",
		],
		"TIGER counties of one state"
	)

	const counties: TIGERCounty[] = []

	for await (const { properties } of rows) {
		counties.push({ geoid: properties.GEOID, name: properties.NAME, title: properties.NAMELSAD })
	}

	return counties.toSorted((a, b) => a.geoid.localeCompare(b.geoid))
}

/**
 * Options for {@link backfillCountyEquivalents}.
 */
export interface CountyEquivalentBackfillOptions {
	/**
	 * The state's counties and county equivalents, from {@link readTIGERCounties}.
	 */
	counties: readonly TIGERCounty[]
	/**
	 * The ten-digit GEOIDs of the state's county subdivisions, from the Census gazetteer file.
	 */
	subdivisions: readonly string[]
	/**
	 * The two-digit FIPS code of the state.
	 */
	stateFIPS: string
	/**
	 * The vintage of both Census files, for the citations.
	 */
	vintage: number
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
 * What {@link backfillCountyEquivalents} did, or would do under `dryRun`.
 */
export interface CountyEquivalentBackfillResult {
	repoDir: string
	written: Array<{ id: number; geoid: string; name: string; subdivisions: number }>
	/**
	 * Counties a `county` record of the fork already holds by GEOID.
	 */
	alreadyHeld: number
	/**
	 * Counties with a subdivision the fork holds no `localadmin` record of, with the GEOIDs absent.
	 */
	incomplete: Array<{ geoid: string; name: string; absent: string[] }>
}

/**
 * Writes a `county` record into the US admin fork for each county equivalent of
 * `options.stateFIPS` the fork holds no record of.
 */
export async function backfillCountyEquivalents(
	options: CountyEquivalentBackfillOptions
): Promise<CountyEquivalentBackfillResult> {
	const reposRoot = PathBuilder.from(options.reposRoot)
	const repoName = wofRepoName("admin", "US")
	const repoDir = reposRoot(repoName)
	const held = new Set<string>()
	const towns = new Map<string, LoadedRecord>()

	for await (const loaded of streamForkRecords(repoDir)) {
		const geoid = String(concordancesOf(loaded)["uscensus:geoid"] ?? "")
		const { properties } = loaded.feature

		if (!geoid.startsWith(options.stateFIPS) || properties["mz:is_current"] === 0) continue

		if (properties["wof:placetype"] === "county") {
			held.add(geoid)
		} else if (properties["wof:placetype"] === "localadmin") {
			towns.set(geoid.slice(-SUBDIVISION_CODE_DIGITS), { ...loaded, text: "" })
		}
	}

	const result: CountyEquivalentBackfillResult = {
		repoDir: repoDir.toString(),
		written: [],
		alreadyHeld: 0,
		incomplete: [],
	}

	const members = new Map<string, LoadedRecord[]>()

	for (const county of options.counties) {
		if (held.has(county.geoid)) {
			result.alreadyHeld++

			continue
		}

		// A code of all zeroes is the Census Bureau's row for water with no subdivision defined.
		const geoids = options.subdivisions.filter(
			(geoid) => geoid.startsWith(county.geoid) && Number(geoid.slice(-SUBDIVISION_CODE_DIGITS)) !== 0
		)

		const records = geoids.map((geoid) => towns.get(geoid.slice(-SUBDIVISION_CODE_DIGITS)))
		const absent = geoids.filter((_, index) => !records[index])

		if (absent.length || !geoids.length) {
			result.incomplete.push({ geoid: county.geoid, name: county.name, absent })
		} else {
			members.set(county.geoid, records.filter(isPresent))
		}
	}

	const unions = await unionGeometries(members)
	const minted = await mailwomanWOFIDs(await sortedGlob(reposRoot, "whosonfirst-data-*", { onlyFiles: false }))
	const newRecords: WOFRecordFeature[] = []
	const tiger = `U.S. Census Bureau, TIGER/Line ${options.vintage} national county file`

	for (const county of options.counties) {
		const records = members.get(county.geoid)
		const union = unions.get(county.geoid)

		if (!records || !union) continue

		const branch = hierarchyOf(records[0]!)[0] ?? {}

		if (!isPresent(branch.region_id)) throw new Error(`${county.geoid}: its first subdivision states no region`)

		const id = nextMailwomanWOFID(minted)

		minted.add(id)

		const hierarchy = {
			...(isPresent(branch.continent_id) ? { continent_id: branch.continent_id } : {}),
			...(isPresent(branch.country_id) ? { country_id: branch.country_id } : {}),
			county_id: id,
			region_id: branch.region_id,
		}

		const total = (key: string) => records.reduce((all, record) => all + Number(record.feature.properties[key] ?? 0), 0)
		const [longitude, latitude] = union.centroid
		const designation = county.title.startsWith(`${county.name} `) ? county.title.slice(county.name.length + 1) : null

		result.written.push({ id, geoid: county.geoid, name: county.name, subdivisions: records.length })

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
				"iso:country": "US",
				"label:eng_x_preferred_longname": [county.title],
				"mailwoman:sources": [
					{
						property: "wof:name",
						citation: `${tiger}: GEOID ${county.geoid}, NAME "${county.name}", NAMELSAD "${county.title}"`,
						url: TIGER_URL,
					},
					{
						property: "geometry",
						citation:
							`The union of the Who's On First localadmin records ` +
							`${records.map((record) => `${record.feature.properties["wof:name"]} (${record.feature.id})`).join(", ")}. ` +
							`The Census Bureau's ${options.vintage} Gazetteer file of county subdivisions lists each under county ${county.geoid}.`,
						url: GAZETTEER_URL,
					},
				],
				"mz:hierarchy_label": 1,
				"mz:is_current": 1,
				"name:eng_x_preferred": [county.name],
				"name:eng_x_variant": [county.title],
				"src:geom": "whosonfirst",
				"wof:belongsto": Object.values(hierarchy)
					.filter((other) => other !== id && other > 0)
					.toSorted((a, b) => a - b),
				"wof:breaches": [],
				"wof:concordances": { "uscensus:geoid": county.geoid },
				"wof:country": "US",
				"wof:geomhash": wofGeometryHash(union.geometry),
				"wof:hierarchy": [hierarchy],
				"wof:id": id,
				"wof:lastmodified": options.lastModified,
				"wof:name": county.name,
				"wof:parent_id": branch.region_id,
				"wof:placetype": "county",
				...(designation ? { "wof:placetype_local": designation } : {}),
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
