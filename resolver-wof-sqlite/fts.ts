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
 * Name of the R*Tree virtual table that indexes WOF places' bounding boxes for proximity / bbox
 * lookups. Built alongside `place_search` by the CLI and `buildFts: true`. Pure SQLite — no
 * extensions needed, the `rtree` virtual-table module ships with the core library.
 */
export const PLACE_BBOX_TABLE = "place_bbox"

/**
 * Counters for a single `buildPlaceSearchFts` run. Exposed so callers (CLI, lazy-build) can render
 * progress to the user.
 */
export interface BuildPlaceSearchFtsResult {
	/** Whether the FTS5 index was created (true) or already existed and was left alone (false). */
	created: boolean
	/** Number of rows in the `place_search` table after the call. */
	indexedRows: number
	/** Whether the R*Tree bbox index was created (true) or already existed (false). */
	bboxCreated: boolean
	/** Number of rows in the `place_bbox` R*Tree after the call. */
	bboxIndexedRows: number
	/** Wall-clock duration of the build step, in milliseconds. */
	durationMs: number
}

export interface BuildPlaceSearchFtsOpts {
	/**
	 * Drop the existing `place_search` AND `place_bbox` tables before building. Default false — if
	 * either already exists the corresponding build step is skipped. Set true when you want to
	 * rebuild against an updated `spr` / `names` snapshot.
	 */
	drop?: boolean
	/**
	 * Optional progress callback invoked after each phase. Useful for CLI output on the planet-scale
	 * builds where the INSERT step can take minutes.
	 */
	onProgress?: (
		phase: "checking" | "dropping" | "creating" | "populating" | "creating-bbox" | "populating-bbox" | "done",
		detail?: string
	) => void
}

/**
 * Build (or rebuild, with `drop: true`) the `place_search` FTS5 virtual table AND the `place_bbox`
 * R*Tree virtual table from the existing `spr` + `names` tables in a WOF SQLite distribution.
 *
 * The FTS5 index is used for name-based MATCH queries; the R*Tree is used for bbox + proximity
 * filtering. Both are pure SQLite — no extensions required.
 *
 * Returns a `BuildPlaceSearchFtsResult` summary. Idempotent when `drop: false` — re-running against
 * an already-indexed DB skips whichever indexes already exist.
 */
export function buildPlaceSearchFts(db: DatabaseSync, opts: BuildPlaceSearchFtsOpts = {}): BuildPlaceSearchFtsResult {
	const start = Date.now()
	const onProgress = opts.onProgress ?? (() => {})

	onProgress("checking")
	const ftsExisting = tableExists(db, PLACE_SEARCH_TABLE)
	const bboxExisting = tableExists(db, PLACE_BBOX_TABLE)

	// ─── FTS5 phase ──────────────────────────────────────────────────
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
		// Excludes deprecated / superseded / non-current places. `is_current` uses a -1/0 convention
		// in WOF — `-1` means "current"; anything else is historical.
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
		ftsCreated = true
	}
	const ftsCountRow = db.prepare(`SELECT COUNT(*) AS n FROM ${PLACE_SEARCH_TABLE}`).get() as { n: number }

	// ─── R*Tree phase ────────────────────────────────────────────────
	let bboxCreated = false
	if (bboxExisting && opts.drop) {
		onProgress("dropping", PLACE_BBOX_TABLE)
		db.exec(`DROP TABLE ${PLACE_BBOX_TABLE}`)
	}
	if (!bboxExisting || opts.drop) {
		onProgress("creating-bbox")
		// R*Tree requires INTEGER PRIMARY KEY (id) + paired min/max for each indexed dimension.
		// `rtree` (not `rtree_i32`) keeps coordinates as REAL — what we want for WGS-84.
		db.exec(`
			CREATE VIRTUAL TABLE ${PLACE_BBOX_TABLE} USING rtree(
				id,
				min_lat, max_lat,
				min_lon, max_lon
			);
		`)
		onProgress("populating-bbox")
		// Only index places that have non-zero coordinates AND a real bbox. WOF stores both the
		// centroid (latitude/longitude) and the bounding box (min_*/max_*). A subset of rows have
		// all-zero coordinates — likely placeholders for deprecated / unmapped entries; the
		// is_current / is_deprecated filter mostly catches them, but we double-check at insert.
		db.exec(`
			INSERT INTO ${PLACE_BBOX_TABLE} (id, min_lat, max_lat, min_lon, max_lon)
			SELECT
				spr.id,
				spr.min_latitude,
				spr.max_latitude,
				spr.min_longitude,
				spr.max_longitude
			FROM spr
			WHERE spr.is_current = -1
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
 * Returns true iff the `place_search` table exists in the connected DB. Used by
 * `WofSqlitePlaceLookup` for its "FTS missing — pass buildFts:true or run the CLI" guard.
 */
export function placeSearchFtsExists(db: DatabaseSync): boolean {
	return tableExists(db, PLACE_SEARCH_TABLE)
}

/** Returns true iff the `place_bbox` R*Tree table exists. Used for opt-in proximity lookup checks. */
export function placeBboxExists(db: DatabaseSync): boolean {
	return tableExists(db, PLACE_BBOX_TABLE)
}

function tableExists(db: DatabaseSync, name: string): boolean {
	const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as
		| { name: string }
		| undefined
	return Boolean(row)
}
