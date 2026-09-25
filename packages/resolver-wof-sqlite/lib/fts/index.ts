/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"

/**
 * Names the FTS5 virtual table that indexes WOF place names for `match` queries.
 */
export const PLACE_SEARCH_TABLE = "place_search"

/**
 * Separates aliases in the `alt_names` bag so a phrase query cannot match across two adjacent aliases.
 *
 * FTS5 gives positions only to tokens, so the separator must be a character that
 * unicode61 indexes as a token; spaces and punctuation leave the aliases adjacent,
 * while the Private Use Area codepoint U+E000 does not.
 * Query sanitizers strip it, so no user query can address the separator token.
 */
export const ALIAS_SEPARATOR = "\uE000"

const ALIAS_SEPARATOR_CODEPOINT = ALIAS_SEPARATOR.codePointAt(0) as number

/**
 * Folds a query or name for exact-tier comparison by lowercasing, trimming
 * and collapsing internal whitespace.
 *
 * Every exact-tier consumer folds through this function so its output compares
 * equal to the aliases {@link aliasBagExactMatch} parses.
 */
export function foldQueryText(input: string): string {
	return input.toLowerCase().trim().replaceAll(/\s+/g, " ")
}

/**
 * Reports whether any alias in an `alt_names` bag exactly equals the already-folded query.
 *
 * A bag without {@link ALIAS_SEPARATOR} is a legacy space-joined bag whose alias boundaries are
 * lost, so it falls back to padded containment and only when no candidate matched strictly,
 * because unrestricted containment would promote fragments such as "York" inside "New York City".
 *
 * @param altNames The `alt_names` bag from `place_search`, or null when the row has no aliases.
 * @param normalizedQuery The query folded by {@link foldQueryText}.
 * @param anyStrictExact Whether any candidate already matched on its canonical name or region abbreviation.
 * Only legacy bags consult it.
 */
export function aliasBagExactMatch(altNames: string | null, normalizedQuery: string, anyStrictExact: boolean): boolean {
	if (altNames === null || altNames === "" || !normalizedQuery) return false

	if (altNames.includes(ALIAS_SEPARATOR)) {
		return altNames.split(ALIAS_SEPARATOR).some((alias) => foldQueryText(alias) === normalizedQuery)
	}

	if (anyStrictExact) return false

	return ` ${foldQueryText(altNames)} `.includes(` ${normalizedQuery} `)
}

/**
 * Names the R*Tree virtual table that indexes WOF place bounding boxes for bbox and proximity lookups.
 */
export const PLACE_BBOX_TABLE = "place_bbox"

/**
 * Names the auxiliary table of `wof:population` per place that drives the population ranking boost.
 *
 * The table is sparse, and a missing row means no boost rather than a penalty.
 */
export const PLACE_POPULATION_TABLE = "place_population"

/**
 * Names the auxiliary table of per-place `referential` and `encyclopedic` salience scores,
 * built by `mailwoman gazetteer importance`.
 *
 * The lookup only carries `encyclopedic` onto results and never ranks by it,
 * and it refuses to read a pre-split table that has a single `importance` column.
 */
export const PLACE_IMPORTANCE_TABLE = "place_importance"

/**
 * Reports what a {@link buildPlaceSearchFTS} run built and how many rows each index holds.
 */
export interface BuildPlaceSearchFTSResult {
	/**
	 * Is true when this call built the FTS5 index and false when an existing one was kept.
	 */
	created: boolean

	/**
	 * Counts the rows in the `place_search` table after the call.
	 */
	indexedRows: number

	/**
	 * Is true when this call built the R*Tree bbox index and false when an existing one was kept.
	 */
	bboxCreated: boolean

	/**
	 * Counts the rows in the `place_bbox` R*Tree after the call.
	 */
	bboxIndexedRows: number

	/**
	 * Gives the wall-clock duration of the whole build in milliseconds.
	 */
	durationMs: number
}

/**
 * Configures {@link buildPlaceSearchFTS}: `drop` rebuilds existing indexes,
 * and `onProgress` receives each build phase.
 */
export interface BuildPlaceSearchFTSOpts {
	/**
	 * Drops and rebuilds existing `place_search` and `place_bbox` tables, such as
	 * after an `spr` or `names` update; by default an existing index is kept.
	 */
	drop?: boolean

	/**
	 * Receives each build phase as it begins, which helps CLI output on planet-scale builds
	 * where population takes minutes.
	 */
	onProgress?: (
		phase: "checking" | "dropping" | "creating" | "populating" | "creating-bbox" | "populating-bbox" | "done",
		detail?: string
	) => void
}

/**
 * Builds the `place_search` FTS5 table and the `place_bbox` R*Tree from a WOF
 * database's `spr` and `names` tables.
 *
 * Without `drop: true`, an index that already exists is kept rather than rebuilt.
 */
export function buildPlaceSearchFTS<DB>(
	db: DatabaseClient<DB>,
	opts: BuildPlaceSearchFTSOpts = {}
): BuildPlaceSearchFTSResult {
	const start = Date.now()
	const onProgress = opts.onProgress ?? (() => {})

	onProgress("checking")
	const ftsExisting = tableExists(db, PLACE_SEARCH_TABLE)
	const bboxExisting = tableExists(db, PLACE_BBOX_TABLE)

	let ftsCreated = false

	if (ftsExisting && opts.drop) {
		onProgress("dropping", PLACE_SEARCH_TABLE)
		db.exec(`DROP TABLE ${PLACE_SEARCH_TABLE}`)
	}

	if (!ftsExisting || opts.drop) {
		onProgress("creating")

		db.exec(`
			CREATE VIRTUAL TABLE ${PLACE_SEARCH_TABLE} USING fts5(
				wof_id UNINDEXED,
				name,
				alt_names,
				tokenize = 'unicode61 remove_diacritics 2'
			);
		`)

		onProgress("populating")

		db.exec(`
			INSERT INTO ${PLACE_SEARCH_TABLE} (wof_id, name, alt_names)
			SELECT
				spr.id,
				spr.name,
				COALESCE((
					SELECT GROUP_CONCAT(
						REPLACE(name, char(${ALIAS_SEPARATOR_CODEPOINT}), ' '),
						' ' || char(${ALIAS_SEPARATOR_CODEPOINT}) || ' '
					) || ' ' || char(${ALIAS_SEPARATOR_CODEPOINT})
					FROM names WHERE names.id = spr.id
				), '')
			FROM spr
			WHERE spr.is_current != 0
				AND spr.is_deprecated = 0
				AND spr.name IS NOT NULL;
		`)

		ftsCreated = true
	}

	const ftsCountRow = db.prepare(`SELECT COUNT(*) AS n FROM ${PLACE_SEARCH_TABLE}`).get() as { n: number }

	let bboxCreated = false

	if (bboxExisting && opts.drop) {
		onProgress("dropping", PLACE_BBOX_TABLE)
		db.exec(`DROP TABLE ${PLACE_BBOX_TABLE}`)
	}

	if (!bboxExisting || opts.drop) {
		onProgress("creating-bbox")

		db.exec(`
			CREATE VIRTUAL TABLE ${PLACE_BBOX_TABLE} USING rtree(
				id,
				min_lat, max_lat,
				min_lon, max_lon
			);
		`)

		onProgress("populating-bbox")

		db.exec(`
			INSERT INTO ${PLACE_BBOX_TABLE} (id, min_lat, max_lat, min_lon, max_lon)
			SELECT
				spr.id,
				spr.min_latitude,
				spr.max_latitude,
				spr.min_longitude,
				spr.max_longitude
			FROM spr
			WHERE spr.is_current != 0
				AND spr.is_deprecated = 0
				AND spr.min_latitude IS NOT NULL
				AND spr.max_latitude IS NOT NULL
				AND spr.min_longitude IS NOT NULL
				AND spr.max_longitude IS NOT NULL
				AND NOT (spr.min_latitude = 0 AND spr.max_latitude = 0
				     AND spr.min_longitude = 0 AND spr.max_longitude = 0);
		`)

		bboxCreated = true
	}

	const bboxCountRow = db.prepare(`SELECT COUNT(*) AS n FROM ${PLACE_BBOX_TABLE}`).get() as { n: number }

	onProgress(
		"done",
		`${ftsCountRow.n} FTS rows + ${bboxCountRow.n} bbox rows ` +
			`(${ftsCreated ? "built" : "preexisting"} / ${bboxCreated ? "built" : "preexisting"})`
	)

	return {
		created: ftsCreated,
		indexedRows: ftsCountRow.n,
		bboxCreated,
		bboxIndexedRows: bboxCountRow.n,
		durationMs: Date.now() - start,
	}
}

/**
 * Reports whether the connected database has the `place_search` FTS table.
 */
export function placeSearchFTSExists<DB>(db: DatabaseClient<DB>): boolean {
	return tableExists(db, PLACE_SEARCH_TABLE)
}

/**
 * Reports whether the connected database has the `place_bbox` R*Tree table.
 */
export function placeBboxExists<DB>(db: DatabaseClient<DB>): boolean {
	return tableExists(db, PLACE_BBOX_TABLE)
}

/**
 * Reports whether the connected database has the `place_population` table.
 */
export function placePopulationExists<DB>(db: DatabaseClient<DB>): boolean {
	return tableExists(db, PLACE_POPULATION_TABLE)
}
