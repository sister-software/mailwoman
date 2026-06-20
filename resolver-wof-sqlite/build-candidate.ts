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
 *   A resolve is a single statement, no FTS, no join to spr: SELECT spr_id, latitude, longitude,
 *   population FROM candidate WHERE name_key = ? AND country_id = ? [AND region_id = ?] AND
 *   placetype_id IN (...) ORDER BY neg_rank ASC LIMIT K; `region_id` (the place's region-tier
 *   ancestor) disambiguates same-name collisions ("Springfield, IL") via a cheap 2-step (resolve
 *   the region first, then filter) at no extra fetch cost.
 *
 *   The name_key normalizer is the SHARED {@link normalizeLocalityForKey} — the query side (the demo
 *   resolver) MUST use the same function, the one-normalizer discipline the address-point shard
 *   uses.
 *
 *   Measured (2026-06-20, vs the 2.6 GB full-DB FTS): ~5 M rows / ~270 MB; 13 range fetches / 0.9 MB
 *   per 8-query session (the full DB needs 243); US locality accuracy 96.8% with the region
 *   2-step.
 */

import { existsSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { normalizeLocalityForKey } from "./street-normalize.js"

/** Boundary-preserving alias-bag separator (#523, U+E000). */
const ALIAS_SEP = ""

export interface BuildCandidateOptions {
	/** Source unified admin DB (e.g. admin-global-priority.db) — needs spr, place_population,
place_search, place_abbr, ancestors. */
	input: string
	/** Output candidate DB path (overwritten if present). */
	output: string
	/** Optional progress callback for CLI / test introspection. */
	onProgress?: (phase: string, message: string) => void
}

export interface BuildCandidateResult {
	rows: number
	places: number
	primaries: number
	aliases: number
	abbrevs: number
}

interface PlaceAttrs {
	cid: number
	rid: number
	ptid: number
	lat: number
	lon: number
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
			neg_rank REAL, spr_id INTEGER, latitude REAL, longitude REAL, population INTEGER, is_primary INTEGER);
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

	const insStage = out.prepare("INSERT INTO cand_stage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")

	// --- pass 1: primaries (and the per-place attrs the alias/abbrev passes reuse) ---
	progress("primaries", "indexing place names")
	const attrs = new Map<number, PlaceAttrs>()
	let nPrim = 0
	out.exec("BEGIN")
	for (const r of src
		.prepare(
			`SELECT s.id AS id, s.name AS name, s.placetype AS placetype, s.country AS country,
				s.latitude AS lat, s.longitude AS lon, COALESCE(pp.population,0) AS pop
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
		const pkey = normalizeLocalityForKey(String(r.name ?? ""))
		const lat = r.lat as number
		const lon = r.lon as number
		attrs.set(sid, { cid, rid, ptid, lat, lon, pop, neg, pkey })
		if (pkey) {
			insStage.run(pkey, cid, rid, ptid, neg, sid, lat, lon, pop, 1)
			nPrim++
		}
	}
	out.exec("COMMIT")
	progress("primaries", `${nPrim.toLocaleString()} primaries; ${attrs.size.toLocaleString()} places`)

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
			insStage.run(k, a.cid, a.rid, a.ptid, a.neg, Number(r.wof_id), a.lat, a.lon, a.pop, 0)
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
		insStage.run(k, a.cid, a.rid, a.ptid, a.neg, Number(r.id), a.lat, a.lon, a.pop, 1)
		nAbbr++
	}
	out.exec("COMMIT")
	progress("abbrevs", `${nAbbr.toLocaleString()} abbrevs`)

	// --- materialize the clustered WITHOUT ROWID table (sorted insert → contiguous leaves) ---
	progress("cluster", "building clustered candidate table + VACUUM")
	out.exec(`
		CREATE TABLE candidate (
			name_key TEXT NOT NULL, country_id INTEGER NOT NULL, region_id INTEGER NOT NULL,
			placetype_id INTEGER NOT NULL, neg_rank REAL NOT NULL, spr_id INTEGER NOT NULL,
			latitude REAL, longitude REAL, population INTEGER, is_primary INTEGER,
			PRIMARY KEY (name_key, country_id, region_id, placetype_id, neg_rank, spr_id)
		) WITHOUT ROWID;
		-- OR IGNORE: an abbrev/alias can normalize to a place's primary key (same place, same rank) → any one row.
		INSERT OR IGNORE INTO candidate
			SELECT name_key, country_id, region_id, placetype_id, neg_rank, spr_id, latitude, longitude, population, is_primary
			FROM cand_stage ORDER BY name_key, country_id, region_id, placetype_id, neg_rank, spr_id;
		DROP TABLE cand_stage;
	`)
	out.exec("VACUUM")

	const rows = Number((out.prepare("SELECT count(*) AS n FROM candidate").get() as { n: number }).n)
	src.close()
	out.close()
	return { rows, places: attrs.size, primaries: nPrim, aliases: nAlias, abbrevs: nAbbr }
}
