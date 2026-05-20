/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `WofSqlitePlaceLookup` — the resolver implementation backed by `node:sqlite` + a Kysely-typed
 *   query layer where the queries are non-trivial, and raw SQL where they aren't (FTS5 MATCH, the
 *   FTS index build).
 *
 *   See `docs/plan/phases/PHASE_4_2_wof_sqlite.md` for the design rationale.
 */

import { Kysely, sql } from "kysely"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"

import { SqliteDialect } from "@mailwoman/core/kysley/dialect"

import {
	buildPlaceSearchFts,
	PLACE_BBOX_TABLE,
	PLACE_POPULATION_TABLE,
	placeBboxExists,
	placePopulationExists,
	placeSearchFtsExists,
} from "./fts.js"
import { bboxAround, haversineKm } from "./geo.js"
import type { WofDatabase } from "./schema.js"
import { pickShardForPlacetype, resolveShards, type ResolvedShard, type ShardConfig } from "./sharding.js"
import type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WofPlacetype } from "./types.js"

export interface WofSqlitePlaceLookupOpts {
	/**
	 * Path to the WOF SQLite distribution on disk. Mutually exclusive with `database`.
	 *
	 * **Single string** — opens that one DB as the main shard.
	 *
	 * **Array** — opens the first entry as main, then ATTACHes each subsequent entry as a separate
	 * SQLite schema. Schema names are derived from the filename (`whosonfirst-data-postalcode-
	 * us-latest.db` → `postalcode_us`); override with `ShardConfig.schemaName` when the filename
	 * doesn't follow WOF convention. See `sharding.ts` for the derivation rules.
	 *
	 * Routing: queries with a `placetype` matching a shard's name (or explicit `placetypes` hint) are
	 * sent to that shard; everything else hits main. Cross-shard UNION is NOT done — BM25 isn't
	 * comparable across separately-indexed corpora.
	 */
	databasePath?: string | ReadonlyArray<string | ShardConfig>
	/**
	 * Pre-opened DatabaseSync — primarily for tests against an inline fixture DB. Mutually exclusive
	 * with `databasePath`. Multi-shard requires `databasePath` (so the lookup owns the ATTACH).
	 */
	database?: DatabaseSync
	/**
	 * If true, build the FTS5 `place_search` virtual table on construction if it doesn't already
	 * exist. The upstream WOF distribution does NOT ship FTS5, so callers either set this once on
	 * first open or pre-build it via the operator-side CLI documented in the README. Default false —
	 * the resolver assumes the index already exists and errors loudly if it doesn't.
	 *
	 * With multi-shard, `buildFts: true` builds the index on the **main** shard only. Other shards
	 * must be pre-built via `mailwoman-wof-build-fts` — operator script for predictable cost.
	 */
	buildFts?: boolean
}

/**
 * Ranking weights for `findPlace`. Tweakable per-instance but defaults match the values declared in
 * the Phase 4.2 plan doc.
 */
export interface RankingWeights {
	/** Boost when the candidate's placetype matches an explicit `placetype` filter. */
	placetypeMatchBoost: number
	/** Boost when the candidate is a locality and no explicit placetype was requested. */
	localityImplicitBoost: number
	/** Boost when the candidate's country matches an explicit `country` filter. */
	countryMatchBoost: number
	/** Boost when the candidate is a direct child of the requested `parentId`. */
	directChildBoost: number
	/** Boost when the candidate is a transitive descendant of the requested `parentId`. */
	descendantBoost: number
	/** Multiplier on the length-penalty term (penalizes much-longer-than-query names). */
	lengthPenaltyWeight: number
	/**
	 * Magnitude of the proximity boost when the query carries `near`. The contribution is
	 * `proximityBoost / (1 + distanceKm / proximityScaleKm)` — at distance 0 the boost is full
	 * magnitude, at `proximityScaleKm` it's half, decaying further with distance. Default tuned so
	 * proximity can overcome a typical FTS rank tie but not dominate a strong text match.
	 */
	proximityBoost: number
	/** Distance (km) at which the proximity boost halves. Tune to the typical query radius. */
	proximityScaleKm: number
	/**
	 * Magnitude of the population boost when the candidate has a known `wof:population`. The
	 * contribution is `populationBoost * log10(1 + population) / populationScaleLog10`, capped at
	 * `populationBoost`. WOF only carries population for ~15% of localities (mostly larger ones);
	 * places without it get +0 (never a penalty). Default tuned so the famous Springfield, IL (pop
	 * ~112k) gets ~0.42 boost — enough to nudge past tiny same-name peers.
	 */
	populationBoost: number
	/**
	 * Population (in log10) at which the boost reaches its full magnitude. Default 6 — i.e. a
	 * population of 1,000,000 gives `populationBoost` exactly. Larger populations cap at the same
	 * value (no compounding effect for megacities).
	 */
	populationScaleLog10: number
}

const DEFAULT_WEIGHTS: RankingWeights = {
	placetypeMatchBoost: 0.5,
	localityImplicitBoost: 0.2,
	countryMatchBoost: 0.3,
	directChildBoost: 0.5,
	descendantBoost: 0.2,
	lengthPenaltyWeight: 0.1,
	proximityBoost: 0.8,
	proximityScaleKm: 100,
	// populationBoost is intentionally large — empirical tuning against real WOF showed BM25 gaps
	// of 1.5-3.0 between famous places and tiny same-name peers (because the famous ones have
	// hundreds of alt-name entries that hurt their FTS document score). To consistently surface
	// "the famous one" for unambiguous queries like "New York" or "Chicago", the population signal
	// needs to dominate. Callers wanting a more conservative balance can drop this in the
	// RankingWeights override.
	populationBoost: 4.0,
	populationScaleLog10: 6,
}

interface RawSearchRow {
	id: number
	name: string
	placetype: string
	country: string | null
	parent_id: number | null
	rank: number // BM25 (lower = better in SQLite); we negate to get higher-is-better
	lat: number | null
	lon: number | null
	population: number | null // from the place_population aux table; null when missing
}

export class WofSqlitePlaceLookup implements PlaceLookup, Disposable {
	readonly #db: DatabaseSync
	readonly #ownsDb: boolean
	readonly #kysely: Kysely<WofDatabase>
	readonly #weights: RankingWeights
	/**
	 * Cached at construction so we don't `sqlite_master` query on every findPlace call. Bbox + near-
	 * with-radius queries fall back to no-filter when this is false, preserving compatibility with
	 * DBs that were FTS-built before the R*Tree shipped.
	 *
	 * Per-shard: a shard is only considered to have the bbox index if its own R*Tree table exists.
	 */
	readonly #hasBboxIndex: Map<string, boolean>
	/**
	 * Per-shard probe for the `place_population` aux table. When false, the LEFT JOIN is omitted from
	 * the SELECT and population boost is 0 for every row — preserves compatibility with DBs built
	 * before this feature shipped.
	 */
	readonly #hasPopulationIndex: Map<string, boolean>
	/**
	 * Resolved shard list. Always at least one entry; first is `main`. Multi-shard adds extras with
	 * their own derived (or override) schema names.
	 */
	readonly #shards: ResolvedShard[]

	constructor(opts: WofSqlitePlaceLookupOpts, weights?: Partial<RankingWeights>) {
		if (opts.database && opts.databasePath) {
			throw new Error("WofSqlitePlaceLookup: pass either `database` or `databasePath`, not both")
		}
		if (!opts.database && !opts.databasePath) {
			throw new Error("WofSqlitePlaceLookup: one of `database` or `databasePath` is required")
		}

		if (opts.database) {
			this.#db = opts.database
			this.#ownsDb = false
			this.#shards = [{ path: ":memory:", schemaName: "main", placetypes: [] }]
		} else {
			const shards = resolveShards(opts.databasePath!)
			this.#shards = shards
			this.#db = new DatabaseSync(shards[0]!.path, { readOnly: false })
			this.#ownsDb = true
			// ATTACH each non-main shard. Schema names were validated by resolveShards, so safe to
			// interpolate directly (SQLite ATTACH doesn't accept parameters for the schema name).
			for (const s of shards.slice(1)) {
				this.#db.exec(`ATTACH DATABASE '${s.path.replace(/'/g, "''")}' AS ${s.schemaName}`)
			}
		}

		// node:sqlite has no .pragma() helper; pragmas are executed as plain SQL.
		this.#db.exec("PRAGMA busy_timeout = 5000")

		if (opts.buildFts) {
			this.#ensureFts()
		} else {
			this.#assertFtsExists()
		}

		this.#kysely = new Kysely<WofDatabase>({
			dialect: new SqliteDialect({ database: this.#db }),
		})
		this.#weights = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) }

		// Probe each shard's aux-table presence — driven by per-shard table existence in
		// sqlite_master. Cached at construction so findPlace doesn't query sqlite_master per call.
		this.#hasBboxIndex = new Map()
		this.#hasPopulationIndex = new Map()
		for (const s of this.#shards) {
			this.#hasBboxIndex.set(s.schemaName, this.#shardHasTable(s.schemaName, PLACE_BBOX_TABLE))
			this.#hasPopulationIndex.set(s.schemaName, this.#shardHasTable(s.schemaName, PLACE_POPULATION_TABLE))
		}
	}

	#shardHasTable(schemaName: string, tableName: string): boolean {
		// For main, the existing helpers work directly. For attached shards we have to ask via the
		// schema-qualified `sqlite_master` view.
		if (schemaName === "main") {
			if (tableName === PLACE_BBOX_TABLE) return placeBboxExists(this.#db)
			if (tableName === PLACE_POPULATION_TABLE) return placePopulationExists(this.#db)
		}
		const row = this.#db
			.prepare(`SELECT name FROM ${schemaName}.sqlite_master WHERE type = 'table' AND name = ?`)
			.get(tableName) as { name: string } | undefined
		return Boolean(row)
	}

	async findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]> {
		const limit = query.limit ?? 10
		const ftsLimit = limit * 4 // over-fetch so post-scoring has room to re-rank

		const placetypes = normalizePlacetypes(query.placetype)
		const ftsQuery = sanitizeFtsQuery(query.text)
		if (!ftsQuery) return []

		// Pick the shard for this query. Multi-shard routing is placetype-driven; a query without
		// `placetype` always goes to main. (Mixed-placetype queries with multiple shards aren't
		// supported in v1 — caller can issue two findPlace calls and merge in TS if needed.)
		const firstPlacetype = placetypes?.[0]
		const shard = pickShardForPlacetype(this.#shards, firstPlacetype)
		const sch = shard.schemaName // bare schema name; safe to interpolate (validated at construction)

		// Filter out historical / superseded / deprecated places by default — they live in the same
		// spr table but should never win a contemporary lookup. `is_current = 0` is the only WOF
		// value that means "not current"; both `-1` (modern) and `1` (legacy) mean current. See #91.
		// Note: with schema-qualified FROM the bare `place_search` reference in MATCH resolves to
		// the FROM table — required by FTS5 parser, see sharding.ts header comment.
		const where: string[] = ["place_search MATCH ?", "spr.is_current != 0", "spr.is_deprecated = 0"]
		const params: SQLInputValue[] = [ftsQuery]

		if (placetypes && placetypes.length > 0) {
			where.push(`spr.placetype IN (${placetypes.map(() => "?").join(", ")})`)
			params.push(...placetypes)
		}
		if (query.country) {
			where.push("spr.country = ?")
			params.push(query.country)
		}
		if (query.parentId !== undefined) {
			where.push(`(spr.parent_id = ? OR spr.id IN (SELECT id FROM ${sch}.ancestors WHERE ancestor_id = ?))`)
			params.push(query.parentId, query.parentId)
		}

		// Bbox + near-with-radius are SQL-level filters via the R*Tree. We only emit the JOIN when
		// the active shard has the R*Tree; missing-but-requested is silently treated as no-bbox-
		// filter so legacy DBs / shards-without-bbox don't crash.
		const shardHasBbox = this.#hasBboxIndex.get(sch) === true
		const useBboxJoin = (query.bbox || query.near?.maxDistanceKm !== undefined) && shardHasBbox
		let joinClause = `JOIN ${sch}.spr ON spr.id = place_search.wof_id`
		if (useBboxJoin) {
			joinClause += ` JOIN ${sch}.${PLACE_BBOX_TABLE} bbox ON bbox.id = spr.id`
			// AABB intersection — both bbox sides must overlap. R*Tree handles this in O(log n).
			const filterBox = query.bbox
				? query.bbox
				: bboxAround(query.near!.lat, query.near!.lon, query.near!.maxDistanceKm!)
			where.push("bbox.min_lat <= ? AND bbox.max_lat >= ?", "bbox.min_lon <= ? AND bbox.max_lon >= ?")
			params.push(filterBox.maxLat, filterBox.minLat, filterBox.maxLon, filterBox.minLon)
		}

		// LEFT JOIN the population aux table when present. Missing-on-this-shard means the SELECT
		// just doesn't include the population column; the post-scoring loop treats it as 0.
		const shardHasPopulation = this.#hasPopulationIndex.get(sch) === true
		const populationSelect = shardHasPopulation
			? `${PLACE_POPULATION_TABLE}.population AS population`
			: `NULL AS population`
		const populationJoin = shardHasPopulation
			? `LEFT JOIN ${sch}.${PLACE_POPULATION_TABLE} ON ${PLACE_POPULATION_TABLE}.id = spr.id`
			: ""

		// Push the population boost into the ORDER BY when the index is available, so famous places
		// (whose long alt-name lists hurt BM25) actually make it into the over-fetch window. The TS
		// post-scoring will still compute the same boost for the final score; this just ensures the
		// candidate set is right.
		//
		// Formula: rank_adjusted = bm25 - populationBoost * min(1.0, log10(1 + pop) / scaleLog10)
		// Lower rank_adjusted = better (matches SQLite's bm25 convention of "more negative = better").
		const orderByExpr = shardHasPopulation
			? `(bm25(place_search) - ? * MIN(1.0, COALESCE(log10(1.0 + ${PLACE_POPULATION_TABLE}.population), 0) / ?))`
			: "bm25(place_search)"

		// Schema-qualified FROM with bare-name MATCH — required syntax for FTS5 on attached schemas.
		// See sharding.ts header for the gotcha that drove this design.
		const stmt = this.#db.prepare(`
			SELECT
				spr.id AS id,
				spr.name,
				spr.placetype,
				spr.country,
				spr.parent_id,
				bm25(place_search) AS rank,
				spr.latitude AS lat,
				spr.longitude AS lon,
				${populationSelect}
			FROM ${sch}.place_search
			${joinClause}
			${populationJoin}
			WHERE ${where.join(" AND ")}
			ORDER BY ${orderByExpr} ASC
			LIMIT ?
		`)
		if (shardHasPopulation) {
			params.push(this.#weights.populationBoost, this.#weights.populationScaleLog10)
		}
		params.push(ftsLimit)

		const rawRows = stmt.all(...params) as unknown as RawSearchRow[]

		const queryLen = query.text.length
		const candidates = rawRows.map((row): PlaceCandidate => {
			// SQLite's bm25() returns a lower-is-better score (negative for matches). Negate so we
			// start from a higher-is-better baseline.
			let score = -row.rank
			if (placetypes && placetypes.length > 0 && placetypes.includes(row.placetype as WofPlacetype)) {
				score += this.#weights.placetypeMatchBoost
			}
			if (!placetypes && row.placetype === "locality") {
				score += this.#weights.localityImplicitBoost
			}
			if (query.country && row.country === query.country) {
				score += this.#weights.countryMatchBoost
			}
			if (query.parentId !== undefined) {
				if (row.parent_id === query.parentId) {
					score += this.#weights.directChildBoost
				} else {
					score += this.#weights.descendantBoost
				}
			}
			const extraLen = Math.max(0, row.name.length - queryLen - 3)
			score -= (this.#weights.lengthPenaltyWeight * extraLen) / 10

			// Proximity boost: only applied when the query carries `near` AND the candidate has real
			// coordinates. The formula decays smoothly with distance so close-but-not-exact hits
			// still benefit; tunable via proximityBoost + proximityScaleKm.
			let distanceKm: number | undefined
			if (query.near && row.lat !== null && row.lon !== null && !(row.lat === 0 && row.lon === 0)) {
				distanceKm = haversineKm(query.near.lat, query.near.lon, row.lat, row.lon)
				score += this.#weights.proximityBoost / (1 + distanceKm / this.#weights.proximityScaleKm)
			}

			// Population boost: capped at `populationBoost` magnitude at `10^populationScaleLog10`
			// people. Missing population → no contribution. Never penalizes.
			if (row.population !== null && row.population > 0 && this.#weights.populationScaleLog10 > 0) {
				const popLog = Math.log10(1 + row.population)
				const popFraction = Math.min(1, popLog / this.#weights.populationScaleLog10)
				score += this.#weights.populationBoost * popFraction
			}

			const candidate: PlaceCandidate = {
				id: row.id,
				name: row.name,
				placetype: row.placetype as WofPlacetype,
				country: row.country ?? "",
				lat: row.lat ?? 0,
				lon: row.lon ?? 0,
				parent_id: row.parent_id ?? undefined,
				score,
			}
			if (distanceKm !== undefined) candidate.distanceKm = distanceKm
			if (row.population !== null && row.population > 0) candidate.population = row.population
			return candidate
		})

		candidates.sort((a, b) => b.score - a.score)
		return Promise.resolve(candidates.slice(0, limit))
	}

	close(): void {
		// Destroying the Kysely instance closes the underlying connection IF we own it. If the caller
		// passed in a pre-opened DatabaseSync (test fixture), respect their ownership.
		void this.#kysely.destroy()
		if (this.#ownsDb) {
			this.#db.close()
		}
	}

	[Symbol.dispose](): void {
		this.close()
	}

	/** Build the FTS5 virtual table from the `names` + `places` tables. */
	#ensureFts(): void {
		buildPlaceSearchFts(this.#db)
	}

	#assertFtsExists(): void {
		if (!placeSearchFtsExists(this.#db)) {
			throw new Error(
				"WofSqlitePlaceLookup: `place_search` FTS5 table is missing. Pass `buildFts: true` to build it on open, or run `mailwoman-wof-build-fts <path-to-wof.db>` ahead of time (see resolver-wof-sqlite/README.md)."
			)
		}
	}
}

function normalizePlacetypes(p: FindPlaceQuery["placetype"]): WofPlacetype[] | null {
	if (!p) return null
	return Array.isArray(p) ? p : [p]
}

/**
 * Make an arbitrary user-typed string safe for FTS5 MATCH.
 *
 * FTS5 has its own query syntax (`"phrase"`, `term1 OR term2`, `prefix*`, NEAR/N, etc.). Letting
 * raw user input through means a user typing `Paris's` or `St. (Petersburg)` causes a syntax
 * error.
 *
 * Per-token rules:
 *
 * - Strip all punctuation except trailing `*` from each whitespace-separated token.
 * - **Trailing `*`** is preserved as FTS5 **prefix syntax** — `627*` becomes the literal `627*`
 *   (unquoted). The caller signaled they want a prefix; respect that.
 * - All other tokens are wrapped in `"..."` as a single-word phrase. Conservative — handles
 *   apostrophes, parens, accented input, etc. safely.
 * - Multiple tokens join with implicit AND.
 *
 * Examples:
 *
 * - `"Paris"` → `"Paris"` (phrase)
 * - `"627*"` → `627*` (prefix)
 * - `"St. (Petersburg)"` → `"St" "Petersburg"` (two phrases, AND-joined)
 * - `"Pari* TX"` → `Pari* "TX"` (mixed prefix + phrase)
 * - `"*"` alone → `""` (no body → drop)
 */
function sanitizeFtsQuery(text: string): string {
	const out: string[] = []
	for (const rawToken of text.normalize("NFKC").split(/\s+/u)) {
		const trimmed = rawToken.trim()
		if (!trimmed) continue
		const hasPrefixStar = trimmed.endsWith("*")
		// Strip everything except letters + numbers from the token body. Apostrophes / hyphens /
		// any embedded `*` all go. The trailing `*` (if any) is reapplied separately below.
		const body = trimmed.replace(/[^\p{L}\p{N}]/gu, "")
		if (!body) continue
		out.push(hasPrefixStar ? `${body}*` : `"${body.replace(/"/g, '""')}"`)
	}
	return out.join(" ")
}

// `sql` is imported only because future Kysely-typed queries will use it; silence "unused" linting.
void sql
