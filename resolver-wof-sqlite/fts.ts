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
 * Boundary-preserving separator between aliases in the `alt_names` bag (#523): U+E000, the first
 * Private Use Area codepoint, written as an escape so the source stays plain ASCII.
 *
 * Why a PUA codepoint and not punctuation: the goal is to stop a phrase query from matching ACROSS
 * two adjacent aliases' concatenation boundary ("York" + "New City" must not phrase-match `"york
 * new"`). FTS5 assigns token positions to TOKENS only — separator characters never consume a
 * position — so any character the tokenizer treats as a boundary leaves the two aliases' tokens
 * adjacent and the false phrase match intact. The separator must therefore be an INDEXED TOKEN that
 * sits between the aliases and breaks positional adjacency.
 *
 * Empirical probe (node:sqlite, `tokenize = 'unicode61 remove_diacritics 2'` — the exact config
 * below). Bag = the aliases "York" and "New City" joined by each candidate separator; query = the
 * cross-boundary phrase `MATCH '"york new"'`:
 *
 * - `' '` (the pre-#523 join, no separator) — false HIT
 * - `' ; '` (punctuation) — false HIT
 * - `' \u2016 '` (double vertical line) — false HIT
 * - `' \x1F '` (ASCII unit separator) — false HIT
 * - `' \uE000 '` (PUA, this constant) — NO match, while `'"york"'` and `'"new city"'` still match the
 *   bag individually under every variant above.
 *
 * U+E000 works because unicode61 classifies it (category Co — neither space nor punctuation) as a
 * token character, so the standalone `\uE000` between aliases is indexed as its own token and the
 * aliases' tokens are no longer positionally adjacent. The remaining requirements also hold:
 *
 * - **Unreachable from queries**: `sanitizeFtsQuery` (Node + WASM resolvers) strips everything
 *   outside `\p{L}\p{N}` from token bodies, and U+E000 is neither — no user query can ever address
 *   the separator token. The demo's `sanitizeFts` strips it explicitly.
 * - **Never in place names**: PUA codepoints are unassigned by definition; real-world WOF names don't
 *   carry them. Defensively, the INSERT below also strips any embedded U+E000 from source names so
 *   a poisoned row can't forge an alias boundary.
 * - **Survives GROUP_CONCAT**: verified — `GROUP_CONCAT(name, ' ' || char(57344) || ' ')` emits the
 *   codepoint intact (`57344` = 0xE000).
 * - **Cost**: one extra token per alias boundary in the FTS document. Marginal BM25 length-norm
 *   impact, on a column whose length stats are already the known #189 problem.
 *
 * Interaction with #189 (split `alt_names` into its own FTS table for independent BM25 length
 * stats): the separator SURVIVES that split as proposed — #189 still GROUP_CONCATs all aliases into
 * one `place_search_alt` row per place, so both the separator and the bag-parsing exact check
 * (`aliasBagExactMatch`) carry over unchanged, just pointed at the new table. Only if #189 were
 * instead built as one-row-per-alias would both become moot (per-alias rows give exact equality and
 * phrase isolation for free). Sequencing: if #189 lands before the next slim-DB artifact rebuild,
 * fold both into ONE rebuild rather than shipping two FTS schema bumps.
 */
export const ALIAS_SEPARATOR = "\uE000"

/** `char()` argument for {@link ALIAS_SEPARATOR} in SQL — keeps the SQL text plain ASCII. */
const ALIAS_SEPARATOR_CODEPOINT = ALIAS_SEPARATOR.codePointAt(0) as number

/**
 * Does any alias in an `alt_names` bag exactly equal the (already-normalized) query? The single
 * shared implementation of the exact-tier alias check for every consumer of the bag — the Node
 * resolver's `#exactMatchIds` fallback, the WASM resolver, and the demo's httpvfs resolver — so the
 * bag format and its parsers can't drift.
 *
 * Two formats exist in the wild:
 *
 * - **Separated bags** (built since #523): aliases joined with {@link ALIAS_SEPARATOR}, plus a
 *   trailing separator so even a single-alias bag self-identifies as separator-formatted. Split +
 *   per-alias equality — a true exact-alias check, matching the semantics of the full `names` table
 *   (`names.name = ? COLLATE NOCASE`), so it runs UNGATED: an alias match is an exact match whether
 *   or not another candidate matched on its canonical name.
 * - **Legacy bags** (pre-#523 artifacts, e.g. an already-deployed slim DB): aliases space-joined,
 *   boundaries lost. Falls back to the historical padded-containment check, gated on
 *   `anyStrictExact` — ungated containment would false-promote interior fragments ("York" inside
 *   the alias "New York City") and cross-boundary fragments ("York New" across "…York" + "New…").
 *   Delete this branch once every shipped artifact carries the separator.
 *
 * @param altNames The `alt_names` bag from `place_search` (null when the row has no aliases).
 * @param normalizedQuery The query, pre-normalized: lowercased, trimmed, internal whitespace
 *   collapsed (every consumer already normalizes this way).
 * @param anyStrictExact Whether ANY candidate in the pool already matched strictly (canonical name
 *   or region abbreviation). Only consulted for legacy bags.
 */
export function aliasBagExactMatch(altNames: string | null, normalizedQuery: string, anyStrictExact: boolean): boolean {
	if (altNames === null || altNames === "" || !normalizedQuery) return false
	const norm = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, " ")
	if (altNames.includes(ALIAS_SEPARATOR)) {
		return altNames.split(ALIAS_SEPARATOR).some((alias) => norm(alias) === normalizedQuery)
	}
	if (anyStrictExact) return false
	return ` ${norm(altNames)} `.includes(` ${normalizedQuery} `)
}

/**
 * Name of the R*Tree virtual table that indexes WOF places' bounding boxes for proximity / bbox
 * lookups. Built alongside `place_search` by the CLI and `buildFts: true`. Pure SQLite — no
 * extensions needed, the `rtree` virtual-table module ships with the core library.
 */
export const PLACE_BBOX_TABLE = "place_bbox"

/**
 * Name of the auxiliary table holding `wof:population` per place. Powers the population-weighted
 * ranking boost. Sparse — WOF only populates this field for ~15% of localities (and mostly larger
 * ones); missing means no boost, never a penalty. Built upstream by `scripts/build-unified-wof.ts`
 * at ingest (and copied through by `build-slim`) — this module consumes it, never builds it.
 *
 * Schema: `(id INTEGER PRIMARY KEY, population INTEGER NOT NULL)`. Plain table, not virtual.
 */
export const PLACE_POPULATION_TABLE = "place_population"

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
		// Excludes only definitively-not-current places. WOF's `is_current` carries TWO conventions:
		// `-1` (modern Who's On First) and `1` (legacy Mapzen-era), both meaning "currently valid".
		// Only `0` means "no longer current". Filtering on `= -1` strict (as Phase 4.2 did) excluded
		// ~42% of admin-US and ~68% of postcode-US — see #91 for the diagnostic + magnitude.
		//
		// Aliases join on the boundary-preserving ALIAS_SEPARATOR token (#523) — space-padded so each
		// alias still tokenizes normally — and any U+E000 embedded in a source name is defensively
		// flattened to a space so it can't forge a boundary. A TRAILING separator marks the bag as
		// separator-formatted even when it holds a single alias, so `aliasBagExactMatch` never
		// mistakes a new bag for a legacy (pre-#523) one. See the ALIAS_SEPARATOR docs for the
		// probe + rationale.
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

	// NOTE: `place_population` is NOT built here. `scripts/build-unified-wof.ts` extracts
	// `wof:population` straight into that table at ingest (the canonical source carries no `geojson`
	// table), and `build-slim` copies it through. This function only owns the two FTS-derived virtual
	// tables, both of which build from `spr` + `names` alone. `placePopulationExists` lets callers
	// check for the pre-built table.

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

/** Returns true iff the `place_population` table exists. Used for opt-in population-ranking checks. */
export function placePopulationExists(db: DatabaseSync): boolean {
	return tableExists(db, PLACE_POPULATION_TABLE)
}

function tableExists(db: DatabaseSync, name: string): boolean {
	const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as
		| { name: string }
		| undefined
	return Boolean(row)
}
