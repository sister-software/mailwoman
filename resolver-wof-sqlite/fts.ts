/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   FTS5 index lifecycle for the WOF SQLite distribution.
 *
 *   Shared by `WofSqlitePlaceLookup` (lazy build via `buildFts: true`) and the operator-side
 *   `mailwoman-wof-build-fts` CLI (ahead-of-time build to avoid first-open latency in production).
 *
 *   Upstream WOF SQLite distributions do NOT ship FTS5. The index lives in a `place_search` virtual
 *   table whose rows mirror `(spr.id, spr.name, GROUP_CONCAT(names.name))` — one current,
 *   non-deprecated place per row, with all alternate names concatenated into a single search-token
 *   bag.
 */

import type { DatabaseSync } from "node:sqlite"

/**
 * Name of the FTS5 virtual table this module owns. Centralized so `WofSqlitePlaceLookup` and the
 * CLI can't drift apart.
 */
export const PLACE_SEARCH_TABLE = "place_search"

/**
 * Counters for a single `buildPlaceSearchFts` run. Exposed so callers (CLI, lazy-build) can render
 * progress to the user.
 */
export interface BuildPlaceSearchFtsResult {
	/** Whether the index was created (true) or already existed and was left alone (false). */
	created: boolean
	/** Number of rows in the `place_search` table after the call. */
	indexedRows: number
	/** Wall-clock duration of the build step, in milliseconds. */
	durationMs: number
}

export interface BuildPlaceSearchFtsOpts {
	/**
	 * Drop the existing `place_search` table before building. Default false — if the table already
	 * exists the call is a no-op. Set true when you want to rebuild against an updated `places` /
	 * `names` snapshot.
	 */
	drop?: boolean
	/**
	 * Optional progress callback invoked after each phase. Useful for CLI output on the planet-scale
	 * builds where the INSERT step can take minutes.
	 */
	onProgress?: (phase: "checking" | "dropping" | "creating" | "populating" | "done", detail?: string) => void
}

/**
 * Build (or rebuild, with `drop: true`) the `place_search` FTS5 virtual table from the existing
 * `places` + `names` tables in a WOF SQLite distribution.
 *
 * Returns a `BuildPlaceSearchFtsResult` summary. Idempotent when `drop: false` — re-running against
 * an already-indexed DB returns `{ created: false, ... }` without rebuilding.
 */
export function buildPlaceSearchFts(db: DatabaseSync, opts: BuildPlaceSearchFtsOpts = {}): BuildPlaceSearchFtsResult {
	const start = Date.now()
	const onProgress = opts.onProgress ?? (() => {})

	onProgress("checking")
	const existing = db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
		.get(PLACE_SEARCH_TABLE) as { name: string } | undefined

	if (existing && !opts.drop) {
		const countRow = db.prepare(`SELECT COUNT(*) AS n FROM ${PLACE_SEARCH_TABLE}`).get() as { n: number }
		onProgress("done", `${countRow.n} rows already indexed`)
		return {
			created: false,
			indexedRows: countRow.n,
			durationMs: Date.now() - start,
		}
	}

	if (existing && opts.drop) {
		onProgress("dropping")
		db.exec(`DROP TABLE ${PLACE_SEARCH_TABLE}`)
	}

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
	// Excludes deprecated / superseded / non-current places. `is_current` uses a -1/0 convention in
	// WOF — `-1` means "current"; anything else is historical.
	db.exec(`
		INSERT INTO ${PLACE_SEARCH_TABLE} (wof_id, name, alt_names)
		SELECT
			spr.id,
			spr.name,
			COALESCE((SELECT GROUP_CONCAT(name, ' ') FROM names WHERE names.id = spr.id), '')
		FROM spr
		WHERE spr.is_current = -1
			AND spr.is_deprecated = 0
			AND spr.name IS NOT NULL;
	`)

	const countRow = db.prepare(`SELECT COUNT(*) AS n FROM ${PLACE_SEARCH_TABLE}`).get() as { n: number }
	onProgress("done", `${countRow.n} rows indexed`)
	return {
		created: true,
		indexedRows: countRow.n,
		durationMs: Date.now() - start,
	}
}

/**
 * Returns true iff the `place_search` table exists in the connected DB. Used by
 * `WofSqlitePlaceLookup` for its "FTS missing — pass buildFts:true or run the CLI" guard.
 */
export function placeSearchFtsExists(db: DatabaseSync): boolean {
	const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(PLACE_SEARCH_TABLE) as
		| { name: string }
		| undefined
	return Boolean(row)
}
