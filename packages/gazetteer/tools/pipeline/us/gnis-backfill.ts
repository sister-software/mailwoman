// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Writes a Who's On First record into the `mailwoman` US admin fork for each GNIS populated
 *   place that no WOF record covers.
 *
 *   A GNIS place is covered when a WOF record in the locality-through-microhood band has the same
 *   name key within {@link SAME_PLACE_KM} of its point, or within {@link SAME_COUNTY_KM} in the
 *   same county. A name key is compared with and without apostrophe-like marks, as the candidate
 *   build stages both, so `Kapaʻau` and `Kapaau` are one name.
 *
 *   A new record's parent is the innermost WOF boundary containing the GNIS point, found by
 *   point-in-polygon against the US polygon database:
 *
 *   - Inside a locality, the place is a `neighbourhood` of that locality. A locality flagged
 *     `wof:statistical_gore` is passed over, because it holds a township's unincorporated area.
 *   - Inside a township (`localadmin`) only, it's a `locality` of the township.
 *   - Inside a county only, it's a `locality` of the county.
 *   - Outside every county boundary, the place is reported and gets a record only when a boundary is added.
 *
 *   The record copies its parent's `wof:hierarchy` and adds itself. Its name, point and `gnis:id`
 *   concordance cite GNIS. Its placetype and hierarchy cite the parent boundary that decided them.
 *
 *   A place whose GNIS id is the `gnis:id` concordance of a record in the mailwoman id range is
 *   skipped, so a second run writes only the places the first one didn't.
 */

import { nextMailwomanWOFID } from "@mailwoman/core/resolver/synthetic-id-ranges"
import type { GNISPopulatedPlace } from "@mailwoman/corpus/us/tools/fetch/usgs-gnis"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import {
	normalizeLocalityForKey,
	withoutApostropheLikeMarks,
	type NameKey,
} from "@mailwoman/resolver-wof-sqlite/street"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { AdminLocator, type LocatedAdmin } from "#tools/pipeline/admin/locator"
import { readMailwomanWOFRecords, writeWOFRecord, type WOFRecordFeature } from "#tools/pipeline/wof/record"
import { wofGeometryHash } from "#tools/pipeline/wof/slim"
import { readWOFFeature, wofRepoName } from "#whosonfirst/extract-repo"
import { hierarchyAncestorsInAnyBranch } from "#whosonfirst/hierarchy"
import type { WOFFeature } from "#whosonfirst/placetypes/admin"

/**
 * A record with the GNIS place's name key this close to its point covers it, in kilometers.
 */
export const SAME_PLACE_KM = 5

/**
 * A record with the GNIS place's name key, in its county, covers it within this distance, in kilometers.
 */
export const SAME_COUNTY_KM = 50

/**
 * The WOF placetypes whose records can cover a GNIS populated place.
 */
const COVERING_PLACETYPES = ["locality", "localadmin", "borough", "macrohood", "neighbourhood", "microhood"]

/**
 * The containing boundaries, innermost first, and the placetype a new record takes under each.
 */
const PARENT_LADDER = [
	{ parent: "locality", child: "neighbourhood" },
	{ parent: "localadmin", child: "locality" },
	{ parent: "county", child: "locality" },
] as const

const REPO = wofRepoName("admin", "US")

/**
 * The GNIS summary page for one feature.
 */
export function gnisFeatureURL(gnisID: number): string {
	return `https://edits.nationalmap.gov/apps/gaz-domestic/public/summary/${gnisID}`
}

/**
 * A county name with its placetype word removed.
 *
 * WOF stores a US county's name without the word (`Petersburg`), and GNIS
 * sometimes includes it (`Petersburg Borough`).
 */
function countyKey(name: string): NameKey {
	return normalizeLocalityForKey(name.replace(/\s+(County|Parish|Borough|Census Area|Municipality)$/iu, ""))
}

function nameKeys(name: string): NameKey[] {
	const key = normalizeLocalityForKey(name)

	return [...new Set([key, withoutApostropheLikeMarks(key)])].filter(Boolean)
}

interface BandRecord {
	id: number
	latitude: number
	longitude: number
	counties: Set<string>
}

/**
 * The WOF US records that can cover a GNIS place, indexed by name key.
 */
class CoverageIndex {
	readonly #byKey = new Map<string, BandRecord[]>()

	add(keys: readonly string[], record: BandRecord): void {
		for (const key of keys) {
			const bucket = this.#byKey.get(key)

			if (bucket) {
				bucket.push(record)
			} else {
				this.#byKey.set(key, [record])
			}
		}
	}

	covers(place: GNISPopulatedPlace & { latitude: number; longitude: number }): boolean {
		const county = place.county ? countyKey(place.county) : null

		for (const key of nameKeys(place.name)) {
			for (const record of this.#byKey.get(key) ?? []) {
				const km = haversine(place.latitude, place.longitude, record.latitude, record.longitude)

				if (km <= SAME_PLACE_KM) return true

				if (county && km <= SAME_COUNTY_KM && record.counties.has(county)) return true
			}
		}

		return false
	}

	static read(adminPath: PathBuilderLike): CoverageIndex {
		using db = new DatabaseClient<WOFDatabase>(adminPath, { readOnly: true })
		const index = new CoverageIndex()
		const placeholders = COVERING_PLACETYPES.map(() => "?").join(",")

		const rows = db
			.prepare(
				`SELECT id, name, latitude, longitude FROM spr WHERE country = 'US' AND is_current != 0 AND is_deprecated = 0 AND placetype IN (${placeholders})`
			)
			.all(...COVERING_PLACETYPES) as Array<{ id: number; name: string; latitude: number; longitude: number }>

		const byID = new Map(rows.map((row) => [row.id, { ...row, counties: new Set<string>(), names: [row.name] }]))

		const counties = db
			.prepare(
				"SELECT a.id AS id, c.name AS name FROM ancestors a JOIN spr c ON c.id = a.ancestor_id WHERE a.ancestor_placetype = 'county'"
			)
			.all() as Array<{ id: number; name: string }>

		for (const { id, name } of counties) {
			byID.get(id)?.counties.add(countyKey(name))
		}

		for (const { id, name } of db.prepare("SELECT id, name FROM names WHERE country = 'US'").all() as Array<{
			id: number
			name: string
		}>) {
			byID.get(id)?.names.push(name)
		}

		for (const record of byID.values()) {
			index.add([...new Set(record.names.flatMap(nameKeys))], record)
		}

		return index
	}
}

/**
 * Options for {@link backfillGNISPlaces}.
 */
export interface GNISBackfillOptions {
	places: Iterable<GNISPopulatedPlace>
	/**
	 * The USPS codes of the states to write, such as `["OH"]`.
	 */
	states: readonly string[]
	adminPath: PathBuilderLike
	/**
	 * The US polygon database, `wof-polygons-us-full.db`.
	 */
	polygonPath: PathBuilderLike
	reposRoot: PathBuilderLike
	/**
	 * Reports what would be written and writes no file.
	 */
	dryRun?: boolean
	/**
	 * The `wof:lastmodified` a record gets, in epoch seconds.
	 */
	now?: () => number
	onRecord?: (record: GNISBackfillRecord) => void
}

/**
 * One record the backfill wrote, or would write on a dry run.
 */
export interface GNISBackfillRecord {
	gnisID: number
	id: number
	name: string
	placetype: string
	parent: LocatedAdmin
	path: string
}

/**
 * What one run did, per state.
 */
export interface GNISBackfillResult {
	records: GNISBackfillRecord[]
	/**
	 * Places in the requested states whose GNIS point is unknown.
	 */
	withoutPoint: number
	/**
	 * Places a WOF record already covers.
	 */
	covered: number
	/**
	 * Places whose GNIS id is already the `gnis:id` concordance of a record in the mailwoman range.
	 */
	alreadyWritten: number
	/**
	 * Places outside every county boundary, with their GNIS ids.
	 */
	unlocated: number[]
}

/**
 * The new record for one GNIS place under `parent`, copying the parent's `wof:hierarchy`.
 */
export function gnisPlaceRecord(
	place: GNISPopulatedPlace & { latitude: number; longitude: number },
	id: number,
	placetype: string,
	parent: LocatedAdmin,
	parentHierarchy: unknown,
	lastModified: number
): WOFRecordFeature {
	const { latitude, longitude } = place
	const geometry = { type: "Point", coordinates: [longitude, latitude] }
	const branches = Array.isArray(parentHierarchy) && parentHierarchy.length ? parentHierarchy : [{}]

	const hierarchy = branches.map((branch: Record<string, number>) => ({
		...branch,
		[`${parent.placetype}_id`]: parent.id,
		[`${placetype}_id`]: id,
	}))

	const belongsTo = [...hierarchyAncestorsInAnyBranch(id, hierarchy).keys()].toSorted((a, b) => a - b)
	const gnis = `U.S. Geological Survey, Geographic Names Information System, populated place ${place.gnisID}`

	return {
		id,
		type: "Feature",
		properties: {
			"edtf:cessation": "uuuu",
			"edtf:inception": "uuuu",
			"geom:area": 0,
			"geom:area_square_m": 0,
			"geom:bbox": `${longitude},${latitude},${longitude},${latitude}`,
			"geom:latitude": latitude,
			"geom:longitude": longitude,
			"iso:country": "US",
			"mailwoman:sources": [
				{ property: "wof:name", citation: `${gnis}: name "${place.name}"`, url: gnisFeatureURL(place.gnisID) },
				{ property: "geometry", citation: `${gnis}: primary point`, url: gnisFeatureURL(place.gnisID) },
				{ property: "wof:concordances", citation: `${gnis}: feature id`, url: gnisFeatureURL(place.gnisID) },
				{
					property: "wof:placetype",
					citation: `The GNIS point lies inside the boundary of WOF ${parent.placetype} ${parent.id} (${parent.name}).`,
				},
				{
					property: "wof:hierarchy",
					citation: `The hierarchy of WOF ${parent.placetype} ${parent.id} (${parent.name}), which contains the GNIS point.`,
				},
			],
			"name:eng_x_preferred": [place.name],
			"src:geom": "gnis",
			"wof:belongsto": belongsTo,
			"wof:breaches": [],
			"wof:concordances": { "gnis:id": place.gnisID },
			"wof:country": "US",
			"wof:geomhash": wofGeometryHash(geometry),
			"wof:hierarchy": hierarchy,
			"wof:id": id,
			"wof:lastmodified": lastModified,
			"wof:name": place.name,
			"wof:parent_id": parent.id,
			"wof:placetype": placetype,
			"wof:repo": REPO,
			"wof:superseded_by": [],
			"wof:supersedes": [],
			"wof:tags": [],
		},
		bbox: [longitude, latitude, longitude, latitude],
		geometry,
	}
}

/**
 * The innermost boundary on {@link PARENT_LADDER} containing a point, with its record,
 * or `null` when no county boundary contains it.
 *
 * A locality WOF flags `wof:statistical_gore` is a township's area outside its incorporated
 * places rather than a town, so a point inside one takes the township as its parent.
 *
 * @throws When a containing place has no record in the clone.
 */
async function containingParent(
	locators: ReadonlyArray<{ child: string; locator: AdminLocator }>,
	longitude: number,
	latitude: number,
	dataDir: PathBuilder
): Promise<{ child: string; parent: LocatedAdmin; parentFeature: WOFFeature } | null> {
	for (const { child, locator } of locators) {
		const parent = locator.locate(longitude, latitude)

		if (!parent) continue

		const parentFeature = await readWOFFeature(parent.id, [dataDir])

		if (!parentFeature) {
			throw new Error(`gnis backfill: WOF ${parent.placetype} ${parent.id} has no record in ${dataDir}`)
		}

		if (parentFeature.properties?.["wof:statistical_gore"] === 1) continue

		return { child, parent, parentFeature }
	}

	return null
}

/**
 * Writes a record for each uncovered GNIS place in `states` into the US admin fork.
 *
 * @throws When the US admin repository isn't cloned under `reposRoot`.
 */
export async function backfillGNISPlaces(options: GNISBackfillOptions): Promise<GNISBackfillResult> {
	const states = new Set(options.states.map((state) => state.toUpperCase()))
	const repoDir = PathBuilder.from(options.reposRoot)(REPO)
	const dataDir = repoDir("data")
	const now = options.now ?? (() => Math.floor(Date.now() / 1000))

	const minted = await readMailwomanWOFRecords([repoDir])
	const mintedIDs = minted.map((record) => record.id)

	const written = new Set(
		minted
			.map((record) => (record.properties["wof:concordances"] as Record<string, unknown> | undefined)?.["gnis:id"])
			.filter((gnisID): gnisID is number => typeof gnisID === "number")
	)

	const coverage = CoverageIndex.read(options.adminPath)

	const locators = PARENT_LADDER.map(({ parent, child }) => ({
		child,
		locator: new AdminLocator({
			adminPath: options.adminPath,
			polygonPath: options.polygonPath,
			placetype: parent,
			country: "US",
		}),
	}))

	const result: GNISBackfillResult = { records: [], withoutPoint: 0, covered: 0, alreadyWritten: 0, unlocated: [] }
	const seen = new Set<number>()

	const places = [...options.places]
		.filter((place) => place.state && states.has(place.state))
		.toSorted((a, b) => a.gnisID - b.gnisID)

	for (const place of places) {
		if (seen.has(place.gnisID)) continue
		seen.add(place.gnisID)

		const { latitude, longitude } = place

		if (place.unknownCoordinates || latitude == null || longitude == null) {
			result.withoutPoint++

			continue
		}

		const located = { ...place, latitude, longitude }

		if (written.has(place.gnisID)) {
			result.alreadyWritten++

			continue
		}

		if (coverage.covers(located)) {
			result.covered++

			continue
		}

		const hit = await containingParent(locators, longitude, latitude, dataDir)

		if (!hit) {
			result.unlocated.push(place.gnisID)

			continue
		}

		const { parentFeature } = hit

		const id = nextMailwomanWOFID(mintedIDs)

		const feature = gnisPlaceRecord(
			located,
			id,
			hit.child,
			hit.parent,
			parentFeature.properties?.["wof:hierarchy"],
			now()
		)

		const path = options.dryRun ? dataDir.toString() : (await writeWOFRecord(repoDir, feature)).toString()

		mintedIDs.push(id)

		// A later GNIS place with this name key inside the coverage distances is covered by this record.
		coverage.add(nameKeys(place.name), { id, latitude, longitude, counties: new Set() })

		const record = { gnisID: place.gnisID, id, name: place.name, placetype: hit.child, parent: hit.parent, path }

		result.records.push(record)
		options.onRecord?.(record)
	}

	return result
}

/**
 * Reads the places a `mailwoman corpus fetch usgs-gnis` run wrote.
 */
export async function readGNISPlaces(path: PathBuilderLike): Promise<GNISPopulatedPlace[]> {
	return Array.fromAsync(JSONSpliterator.fromAsync<GNISPopulatedPlace>(path.toString()))
}
