// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds `wof-polygons.db` from the Who's On First clones: one simplified boundary for each place `candidate.db` holds.
 *   Walks the clones the way the admin ingest does, and drops a superseded or deprecated record the same way.
 */

import { wofReposPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate/schema"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { createPolygonsTable, type PolygonDatabase } from "@mailwoman/resolver-wof-sqlite/polygon-schema"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { simplifyAreaGeometry, type AreaGeometry } from "@mailwoman/spatial/geometries/simplify"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { buildSealedArtifact } from "@mailwoman/sqlite/sealed/build"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { parallelMap } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import type { WOFFeature } from "#whosonfirst"

export interface BuildPolygonsOptions {
	/**
	 * The directory that holds the `whosonfirst-data-*` clones.
	 *
	 * @defaultValue `<data-root>/src/wof-repos/whosonfirst-data`
	 */
	reposDir?: PathBuilderLike
	/**
	 * The gazetteer whose ids decide which records are kept.
	 *
	 * @defaultValue `<data-root>/db/wof/candidate.db`
	 */
	candidatePath?: PathBuilderLike
	/**
	 * The admin database whose concordances link a merged place to its Wikidata id.
	 *
	 * @defaultValue `<data-root>/db/wof/admin-global-priority.db`
	 */
	adminPath?: PathBuilderLike
	out?: PathBuilderLike
	/**
	 * Lower-case country codes to read, or every country when absent.
	 */
	countries?: readonly string[]
	/**
	 * The Douglas-Peucker tolerance in degrees.
	 */
	tolerance?: number
	/**
	 * Reads each country's postcode repository as well as its admin repository.
	 */
	postcodes?: boolean
	concurrency?: number
	onProgress?: (counts: PolygonBuildCounts) => void
}

/**
 * What a build read, with each refused record counted under its reason.
 */
export interface PolygonBuildCounts {
	read: number
	kept: number
	/**
	 * Rows written for a merged place through the Wikidata id it shares with a record.
	 */
	linkedByWikidata: number
	/**
	 * Rows written for a merged country through its country code, for the merged
	 * rows that hold no Wikidata id.
	 */
	linkedByCountryCode: number
	/**
	 * Boundaries simplified past the build's tolerance to fit {@linkcode MAX_GEOMETRY_BYTES}.
	 */
	coarsened: number
	superseded: number
	deprecated: number
	notInGazetteer: number
	pointOnly: number
	unreadable: number
	geometryBytes: number
	inputGeometryBytes: number
}

const DEFAULT_TOLERANCE_DEGREES = 0.001

/**
 * The largest boundary a browser reads and draws for one place.
 */
const MAX_GEOMETRY_BYTES = 200_000

/**
 * The coarsest tolerance a boundary reaches, so an archipelago whose rings
 * cannot shrink further stops the search.
 */
const MAX_TOLERANCE_DEGREES = 0.5

/**
 * The record placetypes that speak for a whole country code.
 * Who's On First files Puerto Rico as a dependency.
 */
const COUNTRY_LEVEL_PLACETYPES: ReadonlySet<string> = new Set(["country", "dependency"])

/**
 * The record's boundary, when its geometry holds an area.
 */
function areaOf(feature: WOFFeature): AreaGeometry | null {
	const { geometry } = feature

	return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon" ? (geometry as AreaGeometry) : null
}

/**
 * Serializes a boundary at the build's tolerance, doubling the tolerance
 * while the result exceeds the size limit.
 */
function fitGeometry(area: AreaGeometry, tolerance: number): { geom: string; coarsened: boolean } {
	let current = tolerance
	let geom = stringifyJSON(simplifyAreaGeometry(area, current))

	while (geom.length > MAX_GEOMETRY_BYTES && current < MAX_TOLERANCE_DEGREES) {
		current *= 2
		geom = stringifyJSON(simplifyAreaGeometry(area, current))
	}

	if (geom.length > MAX_GEOMETRY_BYTES && area.type === "MultiPolygon") {
		geom = stringifyJSON(keepLargestPolygons(simplifyAreaGeometry(area, current)))
	}

	return { geom, coarsened: current !== tolerance }
}

/**
 * Returns the width plus the height of a polygon's outer ring, in degrees.
 */
function polygonSpan(polygon: number[][][]): number {
	let [minLon, minLat, maxLon, maxLat] = [Infinity, Infinity, -Infinity, -Infinity]

	for (const [lon, lat] of polygon[0]!) {
		minLon = Math.min(minLon, lon!)
		maxLon = Math.max(maxLon, lon!)
		minLat = Math.min(minLat, lat!)
		maxLat = Math.max(maxLat, lat!)
	}

	return maxLon - minLon + maxLat - minLat
}

/**
 * Drops a multipolygon's smallest parts until the rest fit the size limit.
 *
 * Each ring keeps at least four positions at any tolerance, so an archipelago of
 * thousands of islets stays too large at the coarsest tolerance.
 */
function keepLargestPolygons(geometry: AreaGeometry): AreaGeometry {
	if (geometry.type !== "MultiPolygon") return geometry

	const largestFirst = (geometry.coordinates as number[][][][])
		.map((polygon) => ({ polygon, span: polygonSpan(polygon) }))
		.toSorted((a, b) => b.span - a.span)

	const kept: number[][][][] = []
	let bytes = stringifyJSON({ ...geometry, coordinates: [] }).length

	for (const { polygon } of largestFirst) {
		bytes += stringifyJSON(polygon).length + 1

		if (bytes > MAX_GEOMETRY_BYTES && kept.length) break

		kept.push(polygon)
	}

	return { ...geometry, coordinates: kept } as AreaGeometry
}

/**
 * Reads the ids a gazetteer holds, so a record no search can return costs no row.
 */
function readGazetteerIDs(candidatePath: PathBuilderLike): Set<number> {
	using db = new DatabaseClient<CandidateDatabase>(candidatePath, { readOnly: true })
	const ids = new Set<number>()

	for (const row of db.prepare("SELECT DISTINCT spr_id FROM candidate").iterate() as Iterable<{ spr_id: number }>) {
		ids.add(Number(row.spr_id))
	}

	return ids
}

/**
 * Reads the gazetteer places each Wikidata id reaches.
 *
 * Half the gazetteer's places come from the Overture and GeoNames merges under ids no
 * Who's On First record holds, and their spellings differ from a record's.
 * The Wikidata id joins them to a record's boundary.
 */
function readWikidataLinks(adminPath: PathBuilderLike, gazetteerIDs: ReadonlySet<number>): Map<string, number[]> {
	using db = new DatabaseClient<WOFDatabase>(adminPath, { readOnly: true })
	const links = new Map<string, number[]>()
	const rows = db.prepare("SELECT id, other_id FROM concordances WHERE other_source = 'wd:id'").iterate()

	for (const { id, other_id: wikidata } of rows as Iterable<{ id: number; other_id: string }>) {
		if (!gazetteerIDs.has(Number(id))) continue

		const places = links.get(String(wikidata))

		if (places) {
			places.push(Number(id))
		} else {
			links.set(String(wikidata), [Number(id)])
		}
	}

	return links
}

/**
 * Reads the gazetteer's country places under each upper-case country code.
 *
 * A merged country row can hold no concordance at all, and a country code identifies one country.
 */
function readCountryPlaces(candidatePath: PathBuilderLike): Map<string, number[]> {
	using db = new DatabaseClient<CandidateDatabase>(candidatePath, { readOnly: true })
	const places = new Map<string, number[]>()

	const rows = db
		.prepare(
			`SELECT DISTINCT c.spr_id AS id, k.code AS code FROM candidate c
			 JOIN placetype_codes t ON t.id = c.placetype_id
			 JOIN country_codes k ON k.id = c.country_id
			 WHERE t.placetype = 'country'`
		)
		.iterate()

	for (const { id, code } of rows as Iterable<{ id: number; code: string }>) {
		const held = places.get(code)

		if (held) {
			held.push(Number(id))
		} else {
			places.set(code, [Number(id)])
		}
	}

	return places
}

/**
 * Lists the clones to read as glob patterns under the repositories directory.
 */
function repositoryPatterns({ countries, postcodes }: Pick<BuildPolygonsOptions, "countries" | "postcodes">): string[] {
	const themes = postcodes ? ["admin", "postalcode"] : ["admin"]

	return themes.flatMap((theme) =>
		(countries ?? ["*"]).map((country) => `whosonfirst-data-${theme}-${country}/data/**/*.geojson`)
	)
}

/**
 * Builds the sealed polygon database and reports what it read.
 */
export async function buildPolygonsDatabase(
	options: BuildPolygonsOptions = {}
): Promise<{ out: string; counts: PolygonBuildCounts }> {
	const out = String(PathBuilder.from(options.out ?? wofDatabasePath("wof-polygons.db")))
	const reposDir = options.reposDir ?? wofReposPath
	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_DEGREES
	const candidatePath = options.candidatePath ?? wofDatabasePath("candidate.db")
	const gazetteerIDs = readGazetteerIDs(candidatePath)
	const countryPlaces = readCountryPlaces(candidatePath)

	const wikidataLinks = readWikidataLinks(
		options.adminPath ?? wofDatabasePath("admin-global-priority.db"),
		gazetteerIDs
	)

	const counts: PolygonBuildCounts = {
		read: 0,
		kept: 0,
		linkedByWikidata: 0,
		linkedByCountryCode: 0,
		coarsened: 0,
		superseded: 0,
		deprecated: 0,
		notInGazetteer: 0,
		pointOnly: 0,
		unreadable: 0,
		geometryBytes: 0,
		inputGeometryBytes: 0,
	}

	const paths = Globerator.from(repositoryPatterns(options), {
		cwd: reposDir,
		absolute: true,
		exclude: ["**/*-alt-*"],
		// A clone can be a symbolic link into the repositories directory, as the US admin clone is.
		// A place reached twice replaces its own row.
		followSymlinks: true,
	})

	return buildSealedArtifact<PolygonDatabase, PolygonBuildCounts, { out: string; counts: PolygonBuildCounts }>({
		out,
		createTables: (db) => createPolygonsTable(db),
		ingest: async (db) => {
			const insert = db.prepare("INSERT OR REPLACE INTO polygons (id, geom) VALUES (?, ?)")
			// A place's own record outranks a boundary reached through a shared Wikidata id.
			const insertLinked = db.prepare("INSERT OR IGNORE INTO polygons (id, geom) VALUES (?, ?)")
			const reads = parallelMap(paths, (path) => readLocalTextFile(path), { concurrency: options.concurrency ?? 64 })

			db.exec("BEGIN")

			for await (const text of reads) {
				counts.read++

				if (counts.read % 100_000 === 0) {
					db.exec("COMMIT")
					db.exec("BEGIN")
					options.onProgress?.(counts)
				}

				let feature: WOFFeature

				try {
					feature = parseJSONStrict<WOFFeature>(text)
				} catch {
					counts.unreadable++

					continue
				}

				const properties = feature.properties
				const id = Number(properties?.["wof:id"] ?? feature.id)
				const wikidata = properties?.["wof:concordances"]?.["wd:id"]
				const linked = (wikidata ? wikidataLinks.get(String(wikidata)) : null)?.filter((place) => place !== id) ?? []

				// A dependency states its parent in `wof:country` and its own code in
				// `iso:country`: Puerto Rico holds US and PR.
				const ownCode = properties?.["iso:country"] ?? properties?.["wof:country"]

				const sameCountry =
					COUNTRY_LEVEL_PLACETYPES.has(String(properties?.["wof:placetype"])) && ownCode
						? (countryPlaces.get(String(ownCode))?.filter((place) => place !== id) ?? [])
						: []

				const held = gazetteerIDs.has(id)

				if (properties?.["wof:superseded_by"]?.length) {
					counts.superseded++
				} else if (properties?.["edtf:deprecated"]) {
					counts.deprecated++
				} else if (!held && !linked.length && !sameCountry.length) {
					counts.notInGazetteer++
				} else {
					const area = areaOf(feature)

					if (!area) {
						counts.pointOnly++

						continue
					}

					const { geom, coarsened } = fitGeometry(area, tolerance)

					counts.coarsened += Number(coarsened)

					if (held) {
						insert.run(id, geom)

						counts.kept++
					}

					for (const place of linked) {
						counts.linkedByWikidata += Number(insertLinked.run(place, geom).changes)
					}

					for (const place of sameCountry) {
						counts.linkedByCountryCode += Number(insertLinked.run(place, geom).changes)
					}

					counts.geometryBytes += geom.length
					counts.inputGeometryBytes += text.length
				}
			}

			db.exec("COMMIT")

			return counts
		},
		finish: async (_db, streamed) => ({ out, counts: streamed }),
	})
}
