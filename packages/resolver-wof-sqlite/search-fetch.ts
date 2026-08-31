/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The FTS5 candidate fetch behind the fuzzy name match: the schema-qualified `place_search`
 *   MATCH, its population-ordered companion fetch, and the raw row shape both of them return.
 *
 *   Bbox and near-with-radius narrow at the SQL level through SQLite's built-in `rtree`, whose index name and schema
 *   live in `fts.ts` beside the FTS5 build. That is why this package pulls neither SpatiaLite nor turf: the R*Tree does
 *   the narrowing, and the passes downstream of it operate on ≤ a few hundred candidates per query rather than the
 *   whole corpus, so an exact haversine over the survivors is cheap.
 */

import { bboxAround } from "@mailwoman/spatial"
import type { DatabaseClient, SQLInputValue } from "@mailwoman/sqlite/client"

import { PLACE_BBOX_TABLE, PLACE_POPULATION_TABLE } from "#fts"
import type { RankingWeights } from "#ranking-weights"
import { allRows } from "#sqlite-utils"
import type { FindPlaceQuery, WOFPlacetype } from "#types"

/**
 * Query length at or below which the FTS window is widened. A two- or three-character query is almost always a region
 * abbreviation, where the exact match can otherwise fall outside the window behind higher-bm25 partial hits — "NY"
 * losing to "New York".
 */
const SHORT_QUERY_MAX_LENGTH = 3

/**
 * Over-fetch floor for SHORT (≤3-char) queries — region abbreviations like "NY"/"VT". An exact-abbrev holder's BM25 is
 * poor (long multilingual alt-name document), so the normal `limit * 4` window can drop it before `exactMatchTiering`
 * promotes it. 200 comfortably covers every same-abbrev region across the 12-country gazetteer (a 2-letter token
 * matches a few dozen regions at most) while staying a cheap region-placetype fetch. See the `#fuzzyNameMatch`
 * over-fetch comment.
 */
const SHORT_QUERY_OVERFETCH = 200

/**
 * How many rows the population-ordered companion fetch (#905) adds to the candidate pool. Small on purpose: its only
 * job is to guarantee the FAMOUS holders of a name enter the pool at all — for "Paris"-class floods the bm25 window is
 * saturated by thousands of tiny same-name rows and no boost inside the bm25-based ORDER BY can rescue a candidate
 * whose bm25 is length-poisoned by ~15 points (see the fetch-site comment).
 */
const POPULATION_FETCH_LIMIT = 15

export interface RawSearchRow {
	id: number
	name: string
	placetype: string
	country: string | null
	parent_id: number | null
	rank: number // BM25 (lower = better in SQLite); we negate to get higher-is-better
	lat: number | null
	lon: number | null
	min_latitude: number | null
	max_latitude: number | null
	min_longitude: number | null
	max_longitude: number | null
	population: number | null // from the place_population aux table; null when missing
	/**
	 * From `place_importance.encyclopedic` when the shard's table carries the two-score split columns. NULL means the
	 * place has no Wikipedia article, or the shard predates the split — absence either way, and never 0 (ROAD_TO_V9 §2).
	 */
	encyclopedic: number | null
}

/**
 * Fetch the raw candidate rows for a name match on one shard: the BM25-ordered window over `place_search` (widened for
 * short queries), plus the population-ordered companion fetch that keeps the prominent holders of a name pool-complete.
 * `schemaName` is the routed shard's bare schema name — validated at construction, so it is interpolated directly.
 */
export function fetchSearchRows<DB>(options: {
	db: DatabaseClient<DB>
	schemaName: string
	query: FindPlaceQuery
	placetypes: WOFPlacetype[] | null
	ftsQuery: string
	limit: number
	hasBboxIndex: ReadonlyMap<string, boolean>
	hasPopulationIndex: ReadonlyMap<string, boolean>
	encyclopedicClauses: ReadonlyMap<string, { select: string; join: string }>
	weights: RankingWeights
}): RawSearchRow[] {
	const {
		db,
		schemaName: sch,
		query,
		placetypes,
		ftsQuery,
		limit,
		hasBboxIndex,
		hasPopulationIndex,
		encyclopedicClauses,
		weights,
	} = options

	// Over-fetch so post-scoring + exact-match tiering have room to re-rank. SHORT queries (a 2–3-char
	// region abbreviation like "NY"/"VT") are the danger case the `exactMatchTiering` docstring flags:
	// the exact-abbrev holder's BM25 is poor (its long multilingual alt-name document tanks the score),
	// so under the normal `limit * 4` window it drops OUT of the candidate pool BEFORE tiering can
	// promote it — "NY" then resolves to a token-matching foreign region (Highland, GB) instead of New
	// York. Widen the window for short queries so the exact match is always present to be tiered.
	// (Cross-country abbrev collisions — "VT" is BOTH Vermont and Viterbo — still need a country/
	// postcode signal to disambiguate; this only rescues the window-drop class, not genuine ambiguity.
	// With a `country` hint every abbrev resolves; bare + no-context lifts 7→10/15 US states.)
	const ftsLimit =
		query.text.trim().length <= SHORT_QUERY_MAX_LENGTH ? Math.max(limit * 4, SHORT_QUERY_OVERFETCH) : limit * 4

	// Filter out historical / superseded / deprecated places by default — they live in the same
	// spr table but should never win a contemporary lookup. `is_current = 0` is the only WOF
	// value that means "not current"; both `-1` (modern) and `1` (legacy) mean current. See #91.
	// Note: with schema-qualified FROM the bare `place_search` reference in MATCH resolves to
	// the FROM table — required by FTS5 parser, see sharding.ts header comment.
	const where: string[] = ["place_search MATCH ?", "spr.is_current != 0", "spr.is_deprecated = 0"]
	const params: SQLInputValue[] = [ftsQuery]

	if (placetypes && placetypes.length) {
		where.push(`spr.placetype IN (${placetypes.map(() => "?").join(", ")})`)
		params.push(...placetypes)
	}

	if (query.country) {
		where.push("spr.country = ?")
		params.push(query.country)
	}

	if (query.parentID !== undefined) {
		where.push(`(spr.parent_id = ? OR spr.id IN (SELECT id FROM ${sch}.ancestors WHERE ancestor_id = ?))`)
		params.push(query.parentID, query.parentID)
	}

	// Bbox + near-with-radius are SQL-level filters via the R*Tree. We only emit the JOIN when
	// the active shard has the R*Tree; missing-but-requested is silently treated as no-bbox-
	// filter so legacy DBs / shards-without-bbox don't crash.
	const shardHasBbox = hasBboxIndex.get(sch) === true
	const useBboxJoin = (query.bbox || query.near?.maxDistanceKm !== undefined) && shardHasBbox
	let joinClause = `JOIN ${sch}.spr ON spr.id = place_search.wof_id`

	if (useBboxJoin) {
		joinClause += ` JOIN ${sch}.${PLACE_BBOX_TABLE} bbox ON bbox.id = spr.id`
		// AABB intersection — both bbox sides must overlap. R*Tree handles this in O(log n).
		const filterBox = query.bbox || bboxAround(query.near!.lat, query.near!.lon, query.near!.maxDistanceKm!)
		where.push("bbox.min_lat <= ? AND bbox.max_lat >= ?", "bbox.min_lon <= ? AND bbox.max_lon >= ?")
		params.push(filterBox.maxLat, filterBox.minLat, filterBox.maxLon, filterBox.minLon)
	}

	// LEFT JOIN the population aux table when present. Missing-on-this-shard means the SELECT
	// just doesn't include the population column; the post-scoring loop treats it as 0.
	const shardHasPopulation = hasPopulationIndex.get(sch) === true

	const populationSelect = shardHasPopulation
		? `${PLACE_POPULATION_TABLE}.population AS population`
		: `NULL AS population`

	const populationJoin = shardHasPopulation
		? `LEFT JOIN ${sch}.${PLACE_POPULATION_TABLE} ON ${PLACE_POPULATION_TABLE}.id = spr.id`
		: ""

	// The encyclopedic score is CARRIED, never ranked on (ROAD_TO_V9 §2, ratified 2026-08-06) — it
	// appears in the SELECT and in no ORDER BY, here or in the companion fetch below. Gated on the
	// split column, so a pre-split shard emits a literal NULL and builds no join at all.
	const { select: encyclopedicSelect, join: encyclopedicJoin } = encyclopedicClauses.get(sch)!

	// Push the population boost into the ORDER BY when the index is available, so famous places
	// (whose long alt-name lists hurt BM25) actually make it into the over-fetch window. The TS
	// post-scoring will still compute the same boost for the final score; this just ensures the
	// candidate set is right.
	//
	// Formula: rank_adjusted = bm25 - populationBoost * min(1.0, log10(1 + pop) / scaleLog10)
	// Lower rank_adjusted = better (matches SQLite's bm25 convention of "more negative = better").
	//
	// #905 — do NOT reach for bm25 column weights here. Measured falsification (2026-07-02): FTS5's
	// bm25 length normalization is polluted by the row's TOTAL document size, so identical 1-token
	// `name` docs read −16.0 (empty alt_names) vs −0.43 (2.7 KB alt_names) EVEN with the alt_names
	// column weighted to zero — no weighting isolates name relevance in this schema. The famous-
	// holder guarantee lives in the population-ordered companion fetch below instead, and the
	// exact tier breaks ties by population in the post-scoring sort.
	const orderByExpr = shardHasPopulation
		? `(bm25(place_search) - ? * MIN(1.0, COALESCE(log10(1.0 + ${PLACE_POPULATION_TABLE}.population), 0) / ?))`
		: "bm25(place_search)"

	// Schema-qualified FROM with bare-name MATCH — required syntax for FTS5 on attached schemas.
	// See sharding.ts header for the failure mode that drove this design.
	const stmt = db.prepare(`
		SELECT
			spr.id AS id,
			spr.name,
			spr.placetype,
			spr.country,
			spr.parent_id,
			bm25(place_search) AS rank,
			spr.latitude AS lat,
			spr.longitude AS lon,
			spr.min_latitude, spr.max_latitude, spr.min_longitude, spr.max_longitude,
			${populationSelect},
			${encyclopedicSelect}
		FROM ${sch}.place_search
		${joinClause}
		${populationJoin}
		${encyclopedicJoin}
		WHERE ${where.join(" AND ")}
		ORDER BY ${orderByExpr} ASC
		LIMIT ?
	`)

	if (shardHasPopulation) {
		params.push(weights.populationBoost, weights.populationScaleLog10)
	}

	params.push(ftsLimit)

	const rawRows = allRows<RawSearchRow>(stmt, ...params)

	// #905 companion fetch: the same MATCH, ordered by population alone. For name floods
	// ("Paris" matches thousands of gap-fill villages) the bm25-based window above cannot admit
	// the famous holder — its bm25 is length-poisoned by the row's alias bulk (measured ~15 pts,
	// vs a +4.0 boost cap), so FR Paris never even reaches post-scoring. This fetch makes the
	// prominent holders of a name pool-complete BY CONSTRUCTION; the exact-tier sort below
	// decides whether they win. Skipped without a population index (nothing to order by).
	if (shardHasPopulation) {
		const popStmt = db.prepare(`
			SELECT
				spr.id AS id,
				spr.name,
				spr.placetype,
				spr.country,
				spr.parent_id,
				bm25(place_search) AS rank,
				spr.latitude AS lat,
				spr.longitude AS lon,
				spr.min_latitude, spr.max_latitude, spr.min_longitude, spr.max_longitude,
				${populationSelect},
				${encyclopedicSelect}
			FROM ${sch}.place_search
			${joinClause}
			${populationJoin}
			${encyclopedicJoin}
			WHERE ${where.join(" AND ")}
			ORDER BY COALESCE(${PLACE_POPULATION_TABLE}.population, 0) DESC
			LIMIT ?
		`)

		const popParams = params.slice(0, -3) // drop the two boost params + ftsLimit
		const seen = new Set(rawRows.map((r) => r.id))

		for (const row of allRows<RawSearchRow>(popStmt, ...popParams, POPULATION_FETCH_LIMIT)) {
			if (!seen.has(row.id)) {
				rawRows.push(row)
			}
		}
	}

	return rawRows
}
