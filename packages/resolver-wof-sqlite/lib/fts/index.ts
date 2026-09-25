/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"

/**
 * The name of the FTS5 virtual table that indexes WOF place names for `match` queries.
 */
export const PLACE_SEARCH_TABLE = "place_search"

/**
 * The separator between aliases in the `alt_names` bag, which stops a phrase
 * query from matching across two aliases.
 *
 * FTS5 assigns positions only to tokens.
 * Spaces and punctuation are not tokens and would leave the aliases adjacent,
 * but unicode61 indexes the Private Use Area codepoint U+E000 as a token.
 *
 * Query sanitizers strip this character, so no user query can match the separator.
 */
export const ALIAS_SEPARATOR = "\uE000"

const ALIAS_SEPARATOR_CODEPOINT = ALIAS_SEPARATOR.codePointAt(0) as number

/**
 * Folds a query or name for exact-tier comparison by lowercasing, trimming
 * and collapsing internal whitespace.
 *
 * Every exact-tier consumer uses this function, so its output compares equal to
 * the aliases that {@link aliasBagExactMatch} parses.
 */
export function foldQueryText(input: string): string {
	return input.toLowerCase().trim().replaceAll(/\s+/g, " ")
}

/**
 * Returns whether any alias in an `alt_names` bag exactly equals the folded query.
 *
 * A bag without {@link ALIAS_SEPARATOR} is a legacy space-joined bag without alias boundaries.
 * For such a bag the
 * function checks word-bounded containment, and only when no candidate matched strictly, because containment alone
 * would promote fragments such as "York" inside "New York City".
 *
 * @param altNames The `alt_names` bag from `place_search`, or null when the row has no aliases.
 * @param normalizedQuery The query folded by {@link foldQueryText}.
 * @param anyStrictExact Whether any candidate already matched on its canonical name or region abbreviation.
 * Only legacy bags use it.
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
 * The name of the R*Tree virtual table that indexes WOF place bounding boxes for bbox and proximity lookups.
 */
export const PLACE_BBOX_TABLE = "place_bbox"

/**
 * The name of the sparse table of `wof:population` per place, which drives the population ranking boost.
 *
 * A place without a row gets no boost and no penalty.
 */
export const PLACE_POPULATION_TABLE = "place_population"

/**
 * The name of the table of per-place `referential` and `encyclopedic` scores,
 * built by `mailwoman gazetteer importance`.
 *
 * The lookup copies `encyclopedic` onto results without ranking by it.
 * It refuses to read an older table with a single `importance` column.
 */
export const PLACE_IMPORTANCE_TABLE = "place_importance"

/**
 * The indexes a {@link buildPlaceSearchFTS} run built and their row counts.
 */
export interface BuildPlaceSearchFTSResult {
	/**
	 * Whether this call built the FTS5 index.
	 * It is false when an existing index was kept.
	 */
	created: boolean

	/**
	 * The row count of the `place_search` table after the call.
	 */
	indexedRows: number

	/**
	 * Whether this call built the R*Tree bbox index.
	 * It is false when an existing index was kept.
	 */
	bboxCreated: boolean

	/**
	 * The row count of the `place_bbox` R*Tree after the call.
	 */
	bboxIndexedRows: number

	/**
	 * The wall-clock duration of the whole build in milliseconds.
	 */
	durationMs: number
}

/**
 * Options for {@link buildPlaceSearchFTS}.
 */
export interface BuildPlaceSearchFTSOpts {
	/**
	 * Whether to drop and rebuild existing `place_search` and `place_bbox` tables,
	 * such as after an `spr` or `names` update.
	 * By default an existing index is kept.
	 */
	drop?: boolean

	/**
	 * Receives each build phase as it begins.
	 * Populating a planet-scale build takes minutes.
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
 * Without `drop: true`, an existing index is kept.
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
 * Returns whether the connected database has the `place_search` FTS table.
 */
export function placeSearchFTSExists<DB>(db: DatabaseClient<DB>): boolean {
	return tableExists(db, PLACE_SEARCH_TABLE)
}

/**
 * Returns whether the connected database has the `place_bbox` R*Tree table.
 */
export function placeBboxExists<DB>(db: DatabaseClient<DB>): boolean {
	return tableExists(db, PLACE_BBOX_TABLE)
}

/**
 * Returns whether the connected database has the `place_population` table.
 */
export function placePopulationExists<DB>(db: DatabaseClient<DB>): boolean {
	return tableExists(db, PLACE_POPULATION_TABLE)
}
