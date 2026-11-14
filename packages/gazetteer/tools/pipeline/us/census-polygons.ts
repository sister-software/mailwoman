// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Builds a polygon database keyed by Who's On First id from Census TIGER/Line boundaries, for
 *   the WOF records that hold a boundary's GEOID as their `uscensus:geoid` concordance.
 *
 *   The admin locator reads it in the `polygons(id, geom)` layout the WOF polygon databases use. It
 *   serves the places that have no boundary in those databases, such as the US territories'
 *   counties and municipios.
 *
 *   The GEOID is the only join. A record without the concordance gets no row, whatever its name.
 *   County, county subdivision and place GEOIDs differ in length (5, 10 and 7 digits), so one
 *   GEOID identifies one boundary.
 */

import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { createPolygonsTable, type PolygonDatabase } from "@mailwoman/resolver-wof-sqlite/polygon-schema"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import type { AreaGeometry } from "@mailwoman/spatial/geometries/simplify"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { buildSealedArtifact } from "@mailwoman/sqlite/sealed/build"
import { readTIGERBoundaries, TIGERBoundaryLevel } from "@mailwoman/tiger/sdk/fetch"
import { AdminLevel1Code, type AdminLevel1Abbreviation } from "@mailwoman/tiger/state"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { DEFAULT_TOLERANCE_DEGREES, fitGeometry } from "#tools/pipeline/polygons"
import { wofCountryOfState } from "#tools/pipeline/us/gnis-backfill"

/**
 * Options for {@link buildCensusPolygonsDatabase}.
 */
export interface BuildCensusPolygonsOptions {
	/**
	 * The USPS codes of the states or territories to read, such as `["PR", "VI"]`.
	 *
	 * A state's records are read from the WOF country `wofCountryOfState` gives.
	 */
	states: readonly AdminLevel1Abbreviation[]
	/**
	 * The admin database whose `uscensus:geoid` concordances key each boundary to a WOF id.
	 *
	 * @defaultValue `<data-root>/db/wof/admin-global-priority.db`
	 */
	adminPath?: PathBuilderLike
	out: PathBuilderLike
	/**
	 * @defaultValue `2024`
	 */
	vintage?: number
	/**
	 * The TIGER download cache root.
	 *
	 * @defaultValue the Mailwoman data root.
	 */
	dataRoot?: string
	/**
	 * The Douglas-Peucker tolerance in degrees.
	 */
	tolerance?: number
}

/**
 * What one state's or territory's build read and joined.
 */
export interface CensusPolygonStateCounts {
	/**
	 * WOF records in the state's country that hold a `uscensus:geoid`.
	 */
	held: number
	/**
	 * Of {@link held}, the records that got a boundary row.
	 */
	joined: number
	/**
	 * TIGER boundaries read and boundaries a WOF record holds, per level.
	 */
	boundaries: Record<TIGERBoundaryLevel, { read: number; joined: number }>
	/**
	 * Joined rows per WOF placetype.
	 */
	joinedByPlacetype: Record<string, number>
	/**
	 * The GEOIDs WOF records hold that match no TIGER boundary of the vintage.
	 */
	unjoinedGEOIDs: string[]
}

interface HeldRecord {
	id: number
	placetype: string
}

/**
 * The WOF records of `country` under each `uscensus:geoid` they hold that begins with `stateFIPS`,
 * as every county, county subdivision and place GEOID begins with its state's code.
 */
function readHeldGEOIDs(adminPath: PathBuilderLike, country: string, stateFIPS: string): Map<string, HeldRecord[]> {
	using db = new DatabaseClient<WOFDatabase>(adminPath, { readOnly: true })
	const held = new Map<string, HeldRecord[]>()

	const rows = db
		.prepare(
			`SELECT s.id AS id, s.placetype AS placetype, c.other_id AS geoid FROM concordances c JOIN spr s ON s.id = c.id
			 WHERE c.other_source = 'uscensus:geoid' AND s.country = ? AND substr(c.other_id, 1, 2) = ?
			 AND s.is_current != 0 AND s.is_deprecated = 0`
		)
		.all(country, stateFIPS) as Array<{ id: number; placetype: string; geoid: string | number }>

	for (const { id, placetype, geoid } of rows) {
		const key = String(geoid)
		const records = held.get(key)

		if (records) {
			records.push({ id, placetype })
		} else {
			held.set(key, [{ id, placetype }])
		}
	}

	return held
}

/**
 * Builds the sealed polygon database and reports, per state, what it joined.
 *
 * @throws When the Census Bureau serves no file for a requested state at a level.
 */
export async function buildCensusPolygonsDatabase(
	options: BuildCensusPolygonsOptions
): Promise<{ out: string; counts: Record<string, CensusPolygonStateCounts> }> {
	const out = String(PathBuilder.from(options.out))
	const adminPath = options.adminPath ?? wofDatabasePath("admin-global-priority.db")
	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_DEGREES

	return buildSealedArtifact<
		PolygonDatabase,
		Record<string, CensusPolygonStateCounts>,
		{ out: string; counts: Record<string, CensusPolygonStateCounts> }
	>({
		out,
		createTables: (db) => createPolygonsTable(db),
		ingest: async (db) => {
			const insert = db.prepare("INSERT INTO polygons (id, geom) VALUES (?, ?)")
			const counts: Record<string, CensusPolygonStateCounts> = {}

			for (const state of options.states) {
				const held = readHeldGEOIDs(adminPath, wofCountryOfState(state), AdminLevel1Code[state])
				const joinedGEOIDs = new Set<string>()

				const stateCounts: CensusPolygonStateCounts = {
					held: [...held.values()].reduce((sum, records) => sum + records.length, 0),
					joined: 0,
					boundaries: {
						county: { read: 0, joined: 0 },
						cousub: { read: 0, joined: 0 },
						place: { read: 0, joined: 0 },
					},
					joinedByPlacetype: {},
					unjoinedGEOIDs: [],
				}

				db.exec("BEGIN")

				for (const level of Object.values(TIGERBoundaryLevel)) {
					for await (const boundary of readTIGERBoundaries({
						level,
						stateFIPS: AdminLevel1Code[state],
						...(options.vintage ? { vintage: options.vintage } : {}),
						...(options.dataRoot ? { dataRoot: options.dataRoot } : {}),
					})) {
						stateCounts.boundaries[level].read++

						const records = held.get(boundary.geoid)

						if (!records) continue

						stateCounts.boundaries[level].joined++
						joinedGEOIDs.add(boundary.geoid)

						const { geom } = fitGeometry(boundary.geometry as AreaGeometry, tolerance)

						for (const record of records) {
							insert.run(record.id, geom)

							stateCounts.joined++

							stateCounts.joinedByPlacetype[record.placetype] =
								(stateCounts.joinedByPlacetype[record.placetype] ?? 0) + 1
						}
					}
				}

				db.exec("COMMIT")

				stateCounts.unjoinedGEOIDs = [...held.keys()].filter((geoid) => !joinedGEOIDs.has(geoid)).toSorted()
				counts[state] = stateCounts
			}

			return counts
		},
		finish: async (_db, counts) => ({ out, counts }),
	})
}
