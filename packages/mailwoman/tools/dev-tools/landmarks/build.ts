/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Turns the Wikidata vital-places inventory into landmark rows and a sealed database.
 */

import { OFFICIAL_LANGUAGES } from "@mailwoman/codex/country/official-languages"
import type { ClassRoots } from "@mailwoman/corpus/tools/fetch/wikidata/vital-places/classify"
import type { VitalPlace } from "@mailwoman/corpus/tools/fetch/wikidata/vital-places/inventory"
import {
	VITAL_PLACE_RENDERINGS,
	vitalPlaceCountry,
	vitalPlaceRendering,
} from "@mailwoman/corpus/tools/fetch/wikidata/vital-places/render"
import {
	createLandmarkTables,
	isLandmarkCode,
	LANDMARK_NAME_COLUMNS,
	type LandmarkDatabase,
	type LandmarkNameTable,
} from "@mailwoman/resolver-wof-sqlite/landmark"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street"
import { buildSealedArtifact } from "@mailwoman/sqlite/sealed/build"
import type { PathBuilderLike } from "path-ts"

import { airportRows, type AirportCode } from "#tools/dev-tools/landmarks/airport-codes"

/**
 * The rows one place contributes: each distinct name key among its labels and aliases.
 *
 * A road holds no row, because the street sources answer it.
 * A settlement holds rows so a town that leads a name can keep that name for the admin ladder.
 */
export function landmarkRows(place: VitalPlace, roots: Readonly<ClassRoots>): LandmarkNameTable[] {
	const rendering = vitalPlaceRendering(place, roots)

	if (rendering !== VITAL_PLACE_RENDERINGS.venue && rendering !== VITAL_PLACE_RENDERINGS.settlement) return []

	const labels = Object.values(place.labels)
	const name = place.labels["en"] ?? labels[0]
	const { coordinate } = place
	const country = vitalPlaceCountry(place)

	if (!name || !coordinate) return []

	const rows = new Map<string, LandmarkNameTable>()

	const add = (written: string, code: string | null, isPrimary: boolean) => {
		const key = normalizeLocalityForKey(written)

		if (key.length < 2 || rows.has(key)) return

		rows.set(key, {
			is_primary: isPrimary ? 1 : 0,
			name_key: key,
			qid: place.qid,
			name,
			kind: rendering === VITAL_PLACE_RENDERINGS.venue ? "venue" : "settlement",
			country,
			latitude: coordinate.lat,
			longitude: coordinate.lon,
			sitelinks: place.sitelinks,
			code,
		})
	}

	// The own-name rows run first, because the first row under a key keeps its rank.
	const ownLanguages = ["en", ...(OFFICIAL_LANGUAGES[country ?? ""]?.official ?? [])]

	for (const language of ownLanguages) {
		const label = place.labels[language]

		if (label) {
			add(label, null, true)
		}
	}

	for (const label of labels) {
		add(label, null, false)
	}

	for (const alias of Object.values(place.aliases).flat()) {
		add(alias, isLandmarkCode(alias) ? alias : null, false)
	}

	return [...rows.values()]
}

/**
 * Builds the sealed database.
 *
 * @returns The number of places and name rows written.
 */
export async function buildLandmarkDatabase(
	places: Iterable<VitalPlace>,
	roots: Readonly<ClassRoots>,
	out: PathBuilderLike,
	airports: Iterable<AirportCode> = []
): Promise<{ places: number; rows: number }> {
	return buildSealedArtifact<LandmarkDatabase, { places: number; rows: number }, { places: number; rows: number }>({
		out,
		createTables: createLandmarkTables,
		ingest: async (database) => {
			const insert = database.prepare(
				`INSERT OR REPLACE INTO landmark_name VALUES (${LANDMARK_NAME_COLUMNS.map(() => "?").join(", ")})`
			)

			const counts = { places: 0, rows: 0 }

			database.exec("BEGIN")

			for (const place of places) {
				const rows = landmarkRows(place, roots)

				counts.places += rows.length ? 1 : 0
				counts.rows += rows.length

				for (const row of rows) {
					insert.run(...LANDMARK_NAME_COLUMNS.map((column) => row[column]))
				}
			}

			// These run last, so an official code replaces the same place's alias row of that code.
			for (const airport of airports) {
				const rows = airportRows(airport)

				counts.rows += rows.length

				for (const row of rows) {
					insert.run(...LANDMARK_NAME_COLUMNS.map((column) => row[column]))
				}
			}

			database.exec("COMMIT")

			return counts
		},
		finish: async (_database, counts) => counts,
	})
}
