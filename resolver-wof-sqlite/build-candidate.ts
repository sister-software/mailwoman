/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the global "candidate" lookup DB from a unified admin WOF DB — the byte-range-optimal
 *   gazetteer the browser demo resolves against. Instead of FTS5 (whose postings for a common name
 *   scatter across a multi-GB file → hundreds of serial range fetches), this materializes one
 *   `WITHOUT ROWID` B-tree keyed `(name_key, country_id, region_id, placetype_id, neg_rank,
 *   spr_id)`: every place's normalized name + distinct aliases + region abbreviations become rows,
 *   population rank is precomputed into `neg_rank`, and the rows are bulk-loaded PRE-SORTED so a
 *   resolve is one contiguous B-tree probe (a handful of pages → 1-2 chunk fetches, regardless of
 *   global volume).
 *
 *   Each row is DENORMALIZED — it carries the place's display `name`, centroid (`latitude`/
 *   `longitude`), and `min/max` bbox — so a resolve is one statement, no FTS, no join to spr:
 *   SELECT spr_id, name, latitude, longitude, min_lat, ... FROM candidate WHERE name_key = ? AND
 *   country_id = ? AND placetype_id IN (...) [AND latitude BETWEEN ...] ORDER BY neg_rank ASC LIMIT
 *   K; The demo cascade resolves a parsed region first (its bbox), then constrains the locality to
 *   that bbox; `region_id` (the place's region-tier ancestor) is also carried for a future region
 *   2-step.
 *
 *   The name_key normalizer is the SHARED {@link normalizeLocalityForKey} — the query side (the demo
 *   resolver {@link WofCandidateTableLookup}) MUST use the same function, the one-normalizer
 *   discipline the address-point shard uses, so build/query stay consistent by construction.
 *
 *   Measured (2026-06-20, vs the 2.6 GB full-DB FTS): ~5 M rows; ~12 range fetches per 8-query
 *   session (the full DB needs 243); US locality 96.8% (region bbox), EU coord parity 88.6%.
 */

import { existsSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { normalizeLocalityForKey } from "./street-normalize.js"

/** Boundary-preserving alias-bag separator (#523, U+E000). */
const ALIAS_SEP = "\u{E000}"

export interface BuildCandidateOptions {
	/** Source unified admin DB — needs spr, place_population, place_search, place_abbr, ancestors. */
	input: string
	/** Output candidate DB path (overwritten if present). */
	output: string
	/**
	 * Optional postcode shards (`spr` rows with `placetype='postalcode'` + real coords, e.g.
	 * postalcode-us.db) — folded in as `postalcode` candidate rows so `findPlace(postalcode)`
	 * resolves a ZIP directly (the demo's primary postcode path; the postcode-*.bin anchor stays the
	 * fallback). Matches the slim wof-hot.db, which took one such postcode DB.
	 */
	postcodes?: string[]
	/** Optional progress callback for CLI / test introspection. */
	onProgress?: (phase: string, message: string) => void
}

export interface BuildCandidateResult {
	rows: number
	places: number
	primaries: number
	aliases: number
	abbrevs: number
	postcodes: number
}

interface PlaceAttrs {
	cid: number
	rid: number
	ptid: number
	name: string
	lat: number
	lon: number
	mnLat: number
	mnLon: number
	mxLat: number
	mxLon: number
	pop: number
	neg: number
	pkey: string
}

export async function buildCandidateTable(opts: BuildCandidateOptions): Promise<BuildCandidateResult> {
	const progress = opts.onProgress ?? (() => {})
	if (existsSync(opts.output)) rmSync(opts.output)

	const src = new DatabaseSync(opts.input, { readOnly: true })
	const out = new DatabaseSync(opts.output)
	out.exec(`
		PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;
		CREATE TABLE country_codes (id INTEGER PRIMARY KEY, code TEXT UNIQUE);
		CREATE TABLE placetype_codes (id INTEGER PRIMARY KEY, placetype TEXT UNIQUE);
		CREATE TABLE cand_stage (name_key TEXT, country_id INTEGER, region_id INTEGER, placetype_id INTEGER,
			neg_rank REAL, spr_id INTEGER, name TEXT, latitude REAL, longitude REAL,
			min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL, population INTEGER, is_primary INTEGER);
	`)

	// --- compact code maps (country/placetype → small int, shrinks the clustered key) ---
	const ccodes = new Map<string, number>()
	const ptcodes = new Map<string, number>()
	const insCc = out.prepare("INSERT INTO country_codes VALUES (?, ?)")
	const insPt = out.prepare("INSERT INTO placetype_codes VALUES (?, ?)")
	const ccId = (code: string | null): number => {
		const c = (code || "??").toUpperCase()
		let id = ccodes.get(c)
		if (id === undefined) {
			id = ccodes.size
			ccodes.set(c, id)
			insCc.run(id, c)
		}
		return id
	}
	const ptId = (pt: string | null): number => {
		const p = pt || ""
		let id = ptcodes.get(p)
		if (id === undefined) {
			id = ptcodes.size
			ptcodes.set(p, id)
			insPt.run(id, p)
		}
		return id
	}

	// --- region_id per place (its region-tier ancestor) for same-name disambiguation ---
	progress("region", "loading region ancestry")
	const regionOf = new Map<number, number>()
	for (const r of src.prepare("SELECT id, ancestor_id FROM ancestors WHERE ancestor_placetype='region'").iterate()) {
		regionOf.set(Number(r.id), Number(r.ancestor_id))
	}
	progress("region", `${regionOf.size.toLocaleString()} places carry a region`)

	const insStage = out.prepare("INSERT INTO cand_stage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")

	// --- pass 1: primaries (and the per-place attrs the alias/abbrev passes reuse) ---
	progress("primaries", "indexing place names")
	const attrs = new Map<number, PlaceAttrs>()
	let nPrim = 0
	out.exec("BEGIN")
	for (const r of src
		.prepare(
			`SELECT s.id AS id, s.name AS name, s.placetype AS placetype, s.country AS country,
				s.latitude AS lat, s.longitude AS lon,
				s.min_latitude AS mnlat, s.min_longitude AS mnlon, s.max_latitude AS mxlat, s.max_longitude AS mxlon,
				COALESCE(pp.population,0) AS pop
			 FROM spr s LEFT JOIN place_population pp ON pp.id = s.id
			 WHERE s.is_current != 0 AND s.is_deprecated = 0`
		)
		.iterate()) {
		const sid = Number(r.id)
		const cid = ccId(r.country as string | null)
		const ptid = ptId(r.placetype as string | null)
		const rid = regionOf.get(sid) ?? 0
		const pop = Number(r.pop) || 0
		const neg = -Math.log10(pop + 1)
		const name = String(r.name ?? "")
		const pkey = normalizeLocalityForKey(name)
		const a: PlaceAttrs = {
			cid,
			rid,
			ptid,
			name,
			lat: r.lat as number,
			lon: r.lon as number,
			mnLat: r.mnlat as number,
			mnLon: r.mnlon as number,
			mxLat: r.mxlat as number,
			mxLon: r.mxlon as number,
			pop,
			neg,
			pkey,
		}
		attrs.set(sid, a)
		if (pkey) {
			insStage.run(pkey, cid, rid, ptid, neg, sid, name, a.lat, a.lon, a.mnLat, a.mnLon, a.mxLat, a.mxLon, pop, 1)
			nPrim++
		}
	}
	out.exec("COMMIT")
	progress("primaries", `${nPrim.toLocaleString()} primaries; ${attrs.size.toLocaleString()} places`)

	const stageRow = (k: string, a: PlaceAttrs, sid: number, isPrimary: number): void => {
		insStage.run(
			k,
			a.cid,
			a.rid,
			a.ptid,
			a.neg,
			sid,
			a.name,
			a.lat,
			a.lon,
			a.mnLat,
			a.mnLon,
			a.mxLat,
			a.mxLon,
			a.pop,
			isPrimary
		)
	}

	// --- pass 2: distinct normalized aliases from place_search.alt_names ---
	progress("aliases", "exploding alias bags")
	let nAlias = 0
	out.exec("BEGIN")
	for (const r of src.prepare("SELECT wof_id, alt_names FROM place_search").iterate()) {
		const a = attrs.get(Number(r.wof_id))
		const alt = r.alt_names as string | null
		if (!a || !alt) continue
		const seen = new Set<string>([a.pkey])
		for (const piece of alt.split(ALIAS_SEP)) {
			const k = normalizeLocalityForKey(piece)
			if (!k || seen.has(k)) continue
			seen.add(k)
			stageRow(k, a, Number(r.wof_id), 0)
			nAlias++
		}
	}
	out.exec("COMMIT")
	progress("aliases", `${nAlias.toLocaleString()} aliases`)

	// --- pass 3: region abbreviations (place_abbr) ---
	let nAbbr = 0
	out.exec("BEGIN")
	for (const r of src.prepare("SELECT id, abbr FROM place_abbr").iterate()) {
		const a = attrs.get(Number(r.id))
		if (!a) continue
		const k = normalizeLocalityForKey(String(r.abbr ?? ""))
		if (!k) continue
		stageRow(k, a, Number(r.id), 1)
		nAbbr++
	}
	out.exec("COMMIT")
	progress("abbrevs", `${nAbbr.toLocaleString()} abbrevs`)

	// --- pass 4: postcodes (separate shards: spr placetype='postalcode' with real coords) ---
	let nPostcode = 0
	for (const pcDb of opts.postcodes ?? []) {
		progress("postcodes", `reading ${pcDb}`)
		const pc = new DatabaseSync(pcDb, { readOnly: true })
		const pcPtid = ptId("postalcode")
		out.exec("BEGIN")
		for (const r of pc
			.prepare(
				`SELECT id, name, country, latitude, longitude,
					min_latitude AS mnlat, min_longitude AS mnlon, max_latitude AS mxlat, max_longitude AS mxlon
				 FROM spr WHERE placetype='postalcode' AND latitude != 0 AND longitude != 0`
			)
			.iterate()) {
			const name = String(r.name ?? "")
			const key = normalizeLocalityForKey(name)
			if (!key) continue
			const lat = r.latitude as number
			const lon = r.longitude as number
			// region_id 0 (a postcode is unique by name+country — no same-name disambiguation); neg_rank 0
			// (no population). bbox = the postcode's own min/max (falls back to the centroid point).
			insStage.run(
				key,
				ccId(r.country as string | null),
				0,
				pcPtid,
				0,
				Number(r.id),
				name,
				lat,
				lon,
				(r.mnlat as number) || lat,
				(r.mnlon as number) || lon,
				(r.mxlat as number) || lat,
				(r.mxlon as number) || lon,
				0,
				1
			)
			nPostcode++
		}
		out.exec("COMMIT")
		pc.close()
	}
	if (nPostcode > 0) progress("postcodes", `${nPostcode.toLocaleString()} postcodes`)

	// --- materialize the clustered WITHOUT ROWID table (sorted insert → contiguous leaves) ---
	progress("cluster", "building clustered candidate table + VACUUM")
	out.exec(`
		CREATE TABLE candidate (
			name_key TEXT NOT NULL, country_id INTEGER NOT NULL, region_id INTEGER NOT NULL,
			placetype_id INTEGER NOT NULL, neg_rank REAL NOT NULL, spr_id INTEGER NOT NULL,
			name TEXT, latitude REAL, longitude REAL, min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,
			population INTEGER, is_primary INTEGER,
			PRIMARY KEY (name_key, country_id, region_id, placetype_id, neg_rank, spr_id)
		) WITHOUT ROWID;
		-- OR IGNORE: an abbrev/alias can normalize to a place's primary key (same place, same rank) → any one row.
		INSERT OR IGNORE INTO candidate
			SELECT name_key, country_id, region_id, placetype_id, neg_rank, spr_id, name, latitude, longitude,
				min_lat, min_lon, max_lat, max_lon, population, is_primary
			FROM cand_stage ORDER BY name_key, country_id, region_id, placetype_id, neg_rank, spr_id;
		DROP TABLE cand_stage;
	`)
	// page_size MUST be set right before VACUUM: node:sqlite initializes the file at the 4096 default on
	// `new DatabaseSync`, so the creation-time pragma is a no-op — only a VACUUM rebuilds at the new size.
	// 8192 matches the sql.js-httpvfs 64 KiB request chunk cleanly (8 pages) and shallows the B-tree.
	out.exec("PRAGMA page_size=8192")
	out.exec("VACUUM")

	const rows = Number((out.prepare("SELECT count(*) AS n FROM candidate").get() as { n: number }).n)
	src.close()
	out.close()
	return { rows, places: attrs.size, primaries: nPrim, aliases: nAlias, abbrevs: nAbbr, postcodes: nPostcode }
}
