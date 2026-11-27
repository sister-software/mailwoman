// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
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
	createOutcomeEvidenceTable,
	type OutcomeAssertion,
	type OutcomeEvidenceTable,
} from "@mailwoman/gazetteer/whosonfirst/outcomes/evidence"
import type { CompiledOutcomeSpec, OutcomeSpecPin } from "@mailwoman/gazetteer/whosonfirst/outcomes/spec"
import {
	createLandmarkTables,
	isLandmarkCode,
	LANDMARK_NAME_COLUMNS,
	type LandmarkDatabase,
} from "@mailwoman/resolver-wof-sqlite/landmark"
import { landmarkNameKey, type LandmarkNameTable } from "@mailwoman/resolver-wof-sqlite/landmark/rows"
import { writeOutcomeDefaults } from "@mailwoman/resolver-wof-sqlite/outcome/schema"
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
		const key = landmarkNameKey(written)

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
			importance: null,
			h3_cell: null,
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
 * The source tag of the assertion written for every `landmarks.db` place:
 * a row in the database is evidence for the `landmark` role.
 */
const LANDMARK_ROLE_SRC = "landmarks:vital-places"

/**
 * A place's assertions: `landmark` by its row, and each identity member its Wikidata classes imply.
 *
 * A place whose classes imply zero identity members takes one from its rendering, `venue` or `place`,
 * because the rendering is itself a deterministic reading of the classes through the class roots.
 *
 * @throws When the place has no `classes` field, the source's type field.
 */
function landmarkAssertions(
	place: VitalPlace,
	rendering: "venue" | "settlement",
	table: OutcomeEvidenceTable,
	identityKinds: ReadonlySet<string>
): OutcomeAssertion[] {
	if (!Array.isArray(place.classes)) {
		throw new TypeError(`${place.qid} has no classes; the vital-places inventory carries no type field to map.`)
	}

	const assertions = place.classes.flatMap((qid) => table.assertionsFor("wikidata", qid))

	if (!assertions.some((assertion) => assertion.stance === "asserts" && identityKinds.has(assertion.outcome))) {
		assertions.push({
			outcome: rendering === "venue" ? "venue" : "place",
			stance: "asserts",
			src: `landmarks:rendering=${rendering}`,
		})
	}

	return [{ outcome: "landmark", stance: "asserts", src: LANDMARK_ROLE_SRC }, ...assertions]
}

/**
 * The counts {@link buildLandmarkDatabase} reports.
 */
export interface LandmarkBuildCounts {
	places: number
	rows: number
	/**
	 * `landmark_outcome` rows, or null without outcome definitions.
	 */
	outcomeRows: number | null
}

/**
 * Builds the sealed database.
 *
 * With `outcomes`, it also writes the outcome tables, each place's assertions keyed by its item.
 *
 * @returns The number of places and name rows written.
 */
export async function buildLandmarkDatabase(
	places: Iterable<VitalPlace>,
	roots: Readonly<ClassRoots>,
	out: PathBuilderLike,
	airports: Iterable<AirportCode> = [],
	outcomes: { spec: CompiledOutcomeSpec; pin: OutcomeSpecPin } | null = null
): Promise<LandmarkBuildCounts> {
	return buildSealedArtifact<LandmarkDatabase, LandmarkBuildCounts, LandmarkBuildCounts>({
		out,
		createTables: createLandmarkTables,
		ingest: async (database) => {
			const insert = database.prepare(
				`INSERT OR REPLACE INTO landmark_name VALUES (${LANDMARK_NAME_COLUMNS.map(() => "?").join(", ")})`
			)

			const table = outcomes ? createOutcomeEvidenceTable(outcomes.spec) : null

			if (outcomes) {
				await writeOutcomeDefaults(database, outcomes.spec, outcomes.pin, "qid")
			}

			const identityKinds = new Set(
				(outcomes?.spec.definitions ?? [])
					.filter((definition) => definition["mw:facet"] === "identity")
					.map((definition) => definition["mw:name"])
			)

			const insertOutcome = table
				? database.prepare("INSERT OR REPLACE INTO landmark_outcome (qid, outcome_id, contested) VALUES (?, ?, ?)")
				: null

			const counts: LandmarkBuildCounts = { places: 0, rows: 0, outcomeRows: table ? 0 : null }

			database.exec("BEGIN")

			for (const place of places) {
				const rows = landmarkRows(place, roots)

				counts.places += rows.length ? 1 : 0
				counts.rows += rows.length

				for (const row of rows) {
					insert.run(...LANDMARK_NAME_COLUMNS.map((column) => row[column]))
				}

				if (table && insertOutcome && rows[0]) {
					for (const row of table.recordRows(
						null,
						landmarkAssertions(place, rows[0].kind as "venue" | "settlement", table, identityKinds)
					)) {
						insertOutcome.run(place.qid, row.outcomeID, row.contested ? 1 : 0)
						counts.outcomeRows! += 1
					}
				}
			}

			// These run last, so an official code replaces the same place's alias row of that code.
			for (const airport of airports) {
				const rows = airportRows(airport)

				counts.rows += rows.length

				for (const row of rows) {
					insert.run(...LANDMARK_NAME_COLUMNS.map((column) => row[column]))
				}

				// The airport query selects airports, so the query itself is the type evidence.
				if (table && insertOutcome && rows[0]) {
					for (const outcome of ["transit.airport", "landmark"]) {
						insertOutcome.run(rows[0].qid, table.idOf(outcome), 0)
						counts.outcomeRows! += 1
					}
				}
			}

			database.exec("COMMIT")

			return counts
		},
		finish: async (_database, counts) => counts,
	})
}
