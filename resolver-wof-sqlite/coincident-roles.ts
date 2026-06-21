/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `buildCoincidentRoles` — derives the **coincident-roles relation** (#403, epic #402) into the
 *   unified gazetteer.
 *
 *   Many places occupy MULTIPLE admin tiers under one name: German city-states (Berlin/Hamburg/Bremen
 *   = city == state), Italian provinces named after their capital (Milano, Varese…), Spanish
 *   provinces-after-capitals, UK unitary authorities, JP prefectures, NL province-capitals
 *   (Utrecht/Groningen), Shanghai. When an address surfaces only the admin role (the parser drops
 *   the locality span), the resolver has no locality to place. The hierarchy-completion step (#405)
 *   repairs that by consulting THIS relation; the table replaces #387's hardcoded 15 km constant
 *   with the gazetteer's own structure, so the runtime is an O(1) membership lookup with no
 *   distance math.
 *
 *   V1 is REGION-tier only (admin.placetype = `region`): the ~124 places matching the census across 9
 *   countries (IT/ES/GB/JP/KR/FR/DE/NL/CN). County-tier same-name coincidences are deliberately
 *   excluded — they're dominated by French cantons and JP counties (admin subdivisions named after
 *   a seat town, not dual-role cities) that don't hit the parser-drops-locality failure; genuine
 *   consolidated city-counties (US SF/Denver) are a separate follow-up needing a relative-size
 *   filter.
 *
 *   A pair `(admin, locality)` is recorded when all hold: same `name` (case-insensitive), the
 *   locality is a `descendant` of the admin (via the `ancestors` table), and their centroids are
 *   within a RELATIVE tolerance — `toleranceFraction × admin-bbox-diagonal`, floored at
 *   `minToleranceKm`. The relative term lets a large Italian province admit a city ~tens of km from
 *   its centroid while a tiny city-state stays tight; the floor catches city-states whose bbox is
 *   small (Bremen's centroids sit 9.3 km apart). The tolerance lives ONLY here at build time — it
 *   never enters the resolver hot path.
 *
 *   `relationship_type` is recorded for debuggability / deferred per-type behavior; v1 completion is
 *   uniform (see #405). It's a coarse classification, not load-bearing.
 *
 *   Mirrors the derived-table builder pattern in `fts.ts` (`buildPlaceSearchFts`). Run incrementally
 *   against an existing `admin-global-priority.db` via `build-coincident-roles-cli.ts`; should also
 *   be wired as a post-step of the main `scripts/build-unified-wof.ts`.
 */

import type { DatabaseSync } from "node:sqlite"

export const COINCIDENT_ROLES_TABLE = "coincident_roles"

/** A place that plays multiple admin roles — one row of the relation, keyed by `admin_id`. */
export interface CoincidentRole {
	localityId: number
	relationshipType: "city-state" | "capital-seat" | "consolidated-county"
	adminPlacetype: string
	distanceKm: number
	population: number
}

export interface BuildCoincidentRolesOpts {
	/** Drop + rebuild the table if it already exists. Default true (the build is cheap + idempotent). */
	drop?: boolean
	/**
	 * Relative tolerance: a pair is kept when centroid distance ≤ `toleranceFraction ×
	 * bbox-diagonal`. Default 0.15.
	 */
	toleranceFraction?: number
	/** Floor (km) under the relative tolerance, so small-bbox city-states still qualify. Default 12. */
	minToleranceKm?: number
	/**
	 * Centroid distance (km) below which a region-tier pair is classed `city-state` (metadata only).
	 * Default 2.
	 */
	cityStateMaxKm?: number
	onProgress?: (phase: string, detail?: string) => void
}

export interface BuildCoincidentRolesResult {
	created: boolean
	rowCount: number
	byCountry: Record<string, number>
	durationMs: number
}

/** Great-circle distance in km between two WGS-84 points. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371
	const dLat = ((lat2 - lat1) * Math.PI) / 180
	const dLon = ((lon2 - lon1) * Math.PI) / 180
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
	return 2 * R * Math.asin(Math.sqrt(s))
}

interface CandidateRow {
	admin_id: number
	admin_placetype: string
	country: string
	locality_id: number
	rlat: number
	rlon: number
	llat: number
	llon: number
	min_latitude: number
	min_longitude: number
	max_latitude: number
	max_longitude: number
	pop: number
}

function tableExists(db: DatabaseSync, name: string): boolean {
	return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name)
}

/**
 * Derive the coincident-roles relation into `db`. Additive — only creates/replaces the
 * `coincident_roles` table; never touches `spr`/`names`/`ancestors`. Idempotent.
 */
export function buildCoincidentRoles(
	db: DatabaseSync,
	opts: BuildCoincidentRolesOpts = {}
): BuildCoincidentRolesResult {
	const start = Date.now()
	const drop = opts.drop ?? true
	const toleranceFraction = opts.toleranceFraction ?? 0.15
	const minToleranceKm = opts.minToleranceKm ?? 12
	const cityStateMaxKm = opts.cityStateMaxKm ?? 2
	const onProgress = opts.onProgress ?? (() => {})

	if (tableExists(db, COINCIDENT_ROLES_TABLE) && drop) {
		onProgress("dropping", COINCIDENT_ROLES_TABLE)
		db.exec(`DROP TABLE ${COINCIDENT_ROLES_TABLE}`)
	}
	onProgress("creating", COINCIDENT_ROLES_TABLE)
	// Raw DDL by design: this is a sync builder consumed by a sync CLI (build-coincident-roles-cli) and
	// 6 sync unit tests, so routing one table through async Kysely would cascade async through all of
	// them for no real gain. See AGENTS.md "Database / inline SQL". (The SELECT + INSERT loop below are
	// likewise the raw hot path.)
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${COINCIDENT_ROLES_TABLE} (
			admin_id INTEGER NOT NULL,
			locality_id INTEGER NOT NULL,
			relationship_type TEXT NOT NULL,
			admin_placetype TEXT NOT NULL,
			distance_km REAL NOT NULL,
			locality_population INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (admin_id, locality_id)
		)
	`)

	onProgress("scanning")
	// Admin (region/county tier) ⋈ same-name DESCENDANT locality. `place_population` is optional (LEFT
	// JOIN → 0 when absent). The relative-tolerance filter + relationship classification happen in JS so
	// the SQL stays a plain join. `spr` exposes the bbox columns we need for the diagonal.
	const candidates = db
		.prepare(
			`SELECT r.id AS admin_id, r.placetype AS admin_placetype, r.country AS country, l.id AS locality_id,
				r.latitude AS rlat, r.longitude AS rlon, l.latitude AS llat, l.longitude AS llon,
				r.min_latitude, r.min_longitude, r.max_latitude, r.max_longitude,
				COALESCE(p.population, 0) AS pop
			FROM spr r
			JOIN spr l ON lower(l.name) = lower(r.name) AND l.placetype = 'locality'
				AND l.is_current != 0 AND l.is_deprecated = 0
			JOIN ${"ancestors"} a ON a.id = l.id AND a.ancestor_id = r.id
			LEFT JOIN place_population p ON p.id = l.id
			WHERE r.placetype = 'region'
				AND r.is_current != 0 AND r.is_deprecated = 0`
		)
		.all() as unknown as CandidateRow[]

	onProgress("filtering", `${candidates.length} candidates`)
	const insert = db.prepare(
		`INSERT OR REPLACE INTO ${COINCIDENT_ROLES_TABLE}
			(admin_id, locality_id, relationship_type, admin_placetype, distance_km, locality_population)
			VALUES (?, ?, ?, ?, ?, ?)`
	)
	const byCountry: Record<string, number> = {}
	let rowCount = 0
	db.exec("BEGIN")
	try {
		for (const c of candidates) {
			const dist = haversineKm(c.rlat, c.rlon, c.llat, c.llon)
			const diag = haversineKm(c.min_latitude, c.min_longitude, c.max_latitude, c.max_longitude)
			const tolerance = Math.max(toleranceFraction * diag, minToleranceKm)
			if (dist > tolerance) continue
			// v1 is region-tier only: a place is a `city-state` when its centroid coincides with the
			// region's (Berlin/Hamburg), else `capital-seat` (a region named after its principal city, e.g.
			// Milano province → Milano comune). `consolidated-county` is reserved for a future county-tier
			// pass (US SF/Denver) — excluded from v1 because county-tier same-name coincidences are
			// dominated by French cantons / JP counties that don't hit the parser-drops-locality failure.
			const relationshipType = dist <= cityStateMaxKm ? "city-state" : "capital-seat"
			insert.run(c.admin_id, c.locality_id, relationshipType, c.admin_placetype, dist, c.pop)
			rowCount++
			byCountry[c.country] = (byCountry[c.country] ?? 0) + 1
		}
		db.exec("COMMIT")
	} catch (err) {
		db.exec("ROLLBACK")
		throw err
	}
	db.exec(`CREATE INDEX IF NOT EXISTS coincident_roles_by_admin ON ${COINCIDENT_ROLES_TABLE} (admin_id)`)

	onProgress("done", `${rowCount} coincident-role rows`)
	return { created: true, rowCount, byCountry, durationMs: Date.now() - start }
}

/** True iff the relation table exists. Used by the resolver to decide whether completion can run. */
export function coincidentRolesExists(db: DatabaseSync): boolean {
	return tableExists(db, COINCIDENT_ROLES_TABLE)
}

/**
 * Load the relation into an in-memory map keyed by `admin_id` for O(1) runtime lookup (#405). Each
 * admin may map to MULTIPLE same-name descendants; the consumer disambiguates (min distance →
 * population → abstain). Returns an empty map when the table is absent.
 */
export function loadCoincidentRoles(db: DatabaseSync): Map<number, CoincidentRole[]> {
	const map = new Map<number, CoincidentRole[]>()
	if (!coincidentRolesExists(db)) return map
	const rows = db
		.prepare(
			`SELECT admin_id, locality_id, relationship_type, admin_placetype, distance_km, locality_population
			FROM ${COINCIDENT_ROLES_TABLE}`
		)
		.all() as unknown as Array<{
		admin_id: number
		locality_id: number
		relationship_type: CoincidentRole["relationshipType"]
		admin_placetype: string
		distance_km: number
		locality_population: number
	}>
	for (const r of rows) {
		const entry: CoincidentRole = {
			localityId: r.locality_id,
			relationshipType: r.relationship_type,
			adminPlacetype: r.admin_placetype,
			distanceKm: r.distance_km,
			population: r.locality_population,
		}
		const list = map.get(r.admin_id)
		if (list) list.push(entry)
		else map.set(r.admin_id, [entry])
	}
	return map
}
