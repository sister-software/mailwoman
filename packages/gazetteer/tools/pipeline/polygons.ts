/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
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
 * The record's boundary, when its geometry holds an area.
 */
function areaOf(feature: WOFFeature): AreaGeometry | null {
	const { geometry } = feature

	return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon" ? (geometry as AreaGeometry) : null
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
	const reposDir = options.reposDir ?? wofReposPath("whosonfirst-data")
	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_DEGREES
	const gazetteerIDs = readGazetteerIDs(options.candidatePath ?? wofDatabasePath("candidate.db"))

	const wikidataLinks = readWikidataLinks(
		options.adminPath ?? wofDatabasePath("admin-global-priority.db"),
		gazetteerIDs
	)

	const counts: PolygonBuildCounts = {
		read: 0,
		kept: 0,
		linkedByWikidata: 0,
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
				const held = gazetteerIDs.has(id)

				if (properties?.["wof:superseded_by"]?.length) {
					counts.superseded++
				} else if (properties?.["edtf:deprecated"]) {
					counts.deprecated++
				} else if (!held && !linked.length) {
					counts.notInGazetteer++
				} else {
					const area = areaOf(feature)

					if (!area) {
						counts.pointOnly++

						continue
					}

					const geom = stringifyJSON(simplifyAreaGeometry(area, tolerance))

					if (held) {
						insert.run(id, geom)

						counts.kept++
					}

					for (const place of linked) {
						counts.linkedByWikidata += Number(insertLinked.run(place, geom).changes)
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
