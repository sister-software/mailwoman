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

import { buildPlaceSearchFts, PLACE_BBOX_TABLE, placeBboxExists, placeSearchFtsExists } from "./fts.js"
import { bboxAround, haversineKm } from "./geo.js"
import type { WofDatabase } from "./schema.js"
import type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WofPlacetype } from "./types.js"

export interface WofSqlitePlaceLookupOpts {
	/** Path to the WOF SQLite distribution on disk. Mutually exclusive with `database`. */
	databasePath?: string
	/**
	 * Pre-opened DatabaseSync — primarily for tests against an inline fixture DB. Mutually exclusive
	 * with `databasePath`.
	 */
	database?: DatabaseSync
	/**
	 * If true, build the FTS5 `place_search` virtual table on construction if it doesn't already
	 * exist. The upstream WOF distribution does NOT ship FTS5, so callers either set this once on
	 * first open or pre-build it via the operator-side CLI documented in the README. Default false —
	 * the resolver assumes the index already exists and errors loudly if it doesn't.
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
	 */
	readonly #hasBboxIndex: boolean

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
		} else {
			this.#db = new DatabaseSync(opts.databasePath!, { readOnly: false })
			this.#ownsDb = true
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
		this.#hasBboxIndex = placeBboxExists(this.#db)
	}

	async findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]> {
		const limit = query.limit ?? 10
		const ftsLimit = limit * 4 // over-fetch so post-scoring has room to re-rank

		const placetypes = normalizePlacetypes(query.placetype)
		const ftsQuery = sanitizeFtsQuery(query.text)
		if (!ftsQuery) return []

		// Filter out historical / superseded / deprecated places by default — they live in the same
		// spr table but should never win a contemporary lookup.
		const where: string[] = ["place_search MATCH ?", "spr.is_current = -1", "spr.is_deprecated = 0"]
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
			where.push("(spr.parent_id = ? OR spr.id IN (SELECT id FROM ancestors WHERE ancestor_id = ?))")
			params.push(query.parentId, query.parentId)
		}

		// Bbox + near-with-radius are SQL-level filters via the R*Tree. We only emit the JOIN when
		// the R*Tree is actually present; missing-but-requested is silently treated as no-bbox-filter
		// so callers without the index don't crash. (Verbose mode could log here — defer.)
		const useBboxJoin = (query.bbox || query.near?.maxDistanceKm !== undefined) && this.#hasBboxIndex
		let joinClause = "JOIN spr ON spr.id = place_search.wof_id"
		if (useBboxJoin) {
			joinClause += ` JOIN ${PLACE_BBOX_TABLE} bbox ON bbox.id = spr.id`
			// AABB intersection — both bbox sides must overlap. R*Tree handles this in O(log n).
			const filterBox = query.bbox
				? query.bbox
				: bboxAround(query.near!.lat, query.near!.lon, query.near!.maxDistanceKm!)
			where.push("bbox.min_lat <= ? AND bbox.max_lat >= ?", "bbox.min_lon <= ? AND bbox.max_lon >= ?")
			params.push(filterBox.maxLat, filterBox.minLat, filterBox.maxLon, filterBox.minLon)
		}

		const stmt = this.#db.prepare(`
			SELECT
				spr.id AS id,
				spr.name,
				spr.placetype,
				spr.country,
				spr.parent_id,
				bm25(place_search) AS rank,
				spr.latitude AS lat,
				spr.longitude AS lon
			FROM place_search
			${joinClause}
			WHERE ${where.join(" AND ")}
			ORDER BY rank ASC
			LIMIT ?
		`)
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
 * raw user input through means a user typing `Paris's` or `St. (Petersburg)` causes a syntax error.
 * We strip everything but `[\p{L}\p{N} ]`, then quote each token as a phrase and join with implicit
 * AND. Conservative but predictable.
 */
function sanitizeFtsQuery(text: string): string {
	const tokens = text
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/u)
		.map((t) => t.trim())
		.filter((t) => t.length > 0)

	if (tokens.length === 0) return ""
	return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ")
}

// `sql` is imported only because future Kysely-typed queries will use it; silence "unused" linting.
void sql
