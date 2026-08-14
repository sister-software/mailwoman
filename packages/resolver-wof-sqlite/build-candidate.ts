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
 *   resolver {@link WOFCandidateTableLookup}) MUST use the same function, the one-normalizer
 *   discipline the address-point shard uses, so build/query stay consistent by construction.
 *
 *   Measured (2026-06-20, vs the 2.6 GB full-DB FTS): ~5 M rows; ~12 range fetches per 8-query
 *   session (the full DB needs 243); US locality 96.8% (region bbox), EU coord parity 88.6%.
 *
 *   #28 adds one more denormalized field, `importance` — the toponym-fame prior that decides a BARE
 *   city name, joined in from a separate score source by name rather than by id (see
 *   `candidate-importance.ts`, which owns that join and explains why the id would be wrong). It is
 *   optional: without {@link BuildCandidateOptions.importance} the column is NULL on every row, which
 *   the consumer reads as unmeasured and ignores.
 */

import { existsSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"

import { createCandidateFTS } from "./candidate-fts.ts"
import { IMPORTANCE_JOIN_GATE_KM, loadImportanceIndex } from "./candidate-importance.ts"
import {
	CANDIDATE_COLUMNS,
	createCandidateStagingTables,
	createCandidateTable,
	type CandidateDatabase,
} from "./candidate-schema.ts"
import { normalizeLocalityForKey } from "./street-normalize.ts"

/**
 * Boundary-preserving alias-bag separator (#523, U+E000).
 */
const ALIAS_SEP = "\u{E000}"

export interface BuildCandidateOptions {
	/**
	 * Source unified admin DB — needs spr, place_population, place_search, place_abbr, ancestors.
	 */
	input: string
	/**
	 * Output candidate DB path (overwritten if present).
	 */
	output: string
	/**
	 * Optional postcode shards (`spr` rows with `placetype='postalcode'` + real coords, e.g. postalcode-us.db) — folded
	 * in as `postalcode` candidate rows so `findPlace(postalcode)` resolves a ZIP directly (the demo's primary postcode
	 * path; the postcode-*.bin anchor stays the fallback). Matches the slim wof-hot.db, which took one such postcode DB.
	 *
	 * Each shard's `names` table is folded in too (#1495) — that's where the GeoNames delivery-city names live
	 * ("Brooklyn" for 11201), and they were previously reachable only through FTS.
	 */
	postcodes?: string[]
	/**
	 * Optional LOCALITY shards (`spr` rows with `placetype='locality'` + real coords, e.g. localities-nz-linz.db — the
	 * #1564 NZ suburb tier) — folded through the same shard loop as the postcode shards, staged as `locality` candidate
	 * rows with no region scope and UNMEASURED population (`neg_rank 0`: a shard row ranks behind any populated namesake
	 * and wins only where its key is the answer). Each shard's `names` table folds as aliases, `is_primary = 0`, same as
	 * the delivery-city pass.
	 */
	localities?: string[]
	/**
	 * Optional WOF admin database carrying a `place_importance` table — the source of the `importance` column (#28), the
	 * toponym-fame prior that decides the bare-city-name class. Joined by `(name_key, country, placetype)` + nearest
	 * centroid, NOT by id; see `candidate-importance.ts` for why the id join silently drops the foreign homonyms the
	 * prior exists to demote.
	 *
	 * Omit it and every row's `importance` is NULL — unmeasured, which is what the consumer's positive-evidence-only rule
	 * already treats as "do not participate", so the artifact is byte-identical to a pre-#28 build except for the empty
	 * column. That is the honest degradation and it is the DEFAULT: a caller with no score source must not get a
	 * population-derived stand-in written into a column that means fame.
	 */
	importance?: string
	/**
	 * Optional progress callback for CLI / test introspection.
	 */
	onProgress?: (phase: string, message: string) => void
}

export interface BuildCandidateResult {
	rows: number
	places: number
	primaries: number
	aliases: number
	abbrevs: number
	postcodes: number
	/**
	 * Delivery-city (and other `names`-table) aliases folded onto postcode rows — #1495. Zero here means the shards
	 * carried no alias names, NOT that the pass was skipped: a shard with no `names` table reports that separately
	 * through `onProgress`.
	 */
	postcodeAliases: number
	/**
	 * Places that took an `importance` score from the join (#28).
	 *
	 * `undefined` and `0` mean different things. `undefined` is "the pass did not run" — no score source was given. A `0`
	 * would be the source matching NOTHING, which is a finding. Never collapse the two.
	 */
	importanceScored?: number
	/**
	 * Places whose `(name_key, country, placetype)` matched a scored group but whose nearest scored centroid was outside
	 * {@link IMPORTANCE_JOIN_GATE_KM} — a different town wearing the same name, refused rather than scored.
	 *
	 * Worth watching across rebuilds: a jump here means the score source and the admin source have drifted apart, and the
	 * join is being asked to guess.
	 */
	importanceGated?: number
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
	/**
	 * The place's toponym-fame score, or null when the score source has no measurement for it (#28). A property of the
	 * PLACE, so it rides {@link stageRow} onto the alias and abbrev rows too — that is how a bare `Moscow` reaches
	 * Москва's score through the alias row that carries the key.
	 */
	imp: number | null
}

export async function buildCandidateTable(opts: BuildCandidateOptions): Promise<BuildCandidateResult> {
	const progress = opts.onProgress ?? (() => {})

	if (existsSync(opts.output)) {
		rmSync(opts.output)
	}

	const src = new DatabaseSync(opts.input, { readOnly: true })
	const out = new DatabaseSync(opts.output)
	// Build-tuning pragmas (raw — Kysely doesn't model PRAGMA). The code dictionaries + the transient
	// staging table come from the SHARED schema DDL, so they can't drift from {@link CandidateDatabase}.
	out.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")
	const kdb = new DatabaseClient<CandidateDatabase>({ database: out })
	await createCandidateStagingTables(kdb)

	// --- compact code maps (country/placetype → small int, shrinks the clustered key). The ids are
	// assigned here; the rows are bulk-inserted via kdb once the passes have discovered every code. ---
	const ccodes = new Map<string, number>()
	const ptcodes = new Map<string, number>()

	const ccID = (code: string | null): number => {
		const c = (code || "??").toUpperCase()
		let id = ccodes.get(c)

		if (id === undefined) {
			id = ccodes.size
			ccodes.set(c, id)
		}

		return id
	}

	const ptID = (pt: string | null): number => {
		const p = pt || ""
		let id = ptcodes.get(p)

		if (id === undefined) {
			id = ptcodes.size
			ptcodes.set(p, id)
		}

		return id
	}

	// --- importance source (#28): loaded BEFORE pass 1, which is the only pass that sees a place's
	// name/country/placetype/centroid together. Absent → every row's `importance` stays NULL. ---
	let importance: ReturnType<typeof loadImportanceIndex> | undefined

	if (opts.importance) {
		progress("importance", `loading place_importance from ${opts.importance}`)
		importance = loadImportanceIndex(opts.importance)

		progress(
			"importance",
			`${importance.stats.places.toLocaleString()} scored places in ${importance.stats.keys.toLocaleString()} (name, country, placetype) groups` +
				(importance.stats.unkeyable ? `; ${importance.stats.unkeyable.toLocaleString()} unkeyable names skipped` : "")
		)
	} else {
		// Never a silent column of nulls: a build without a score source produces one, and the reason has
		// to be visible in the log rather than inferred from the artifact.
		progress("importance", "no score source given — `importance` will be NULL on every row")
	}

	// --- region_id per place (its region-tier ancestor) for same-name disambiguation ---
	progress("region", "loading region ancestry")
	const regionOf = new Map<number, number>()
	let multiRegion = 0

	// A place can carry more than one region-tier ancestor — 59 do on the 2026-08-03 artifact (42
	// localities, mostly Chinese places on an ambiguous boundary). One `region_id` column holds one of
	// them, and which one it ought to be is a real question this is not the place to answer.
	//
	// MIN is arbitrary but STABLE: an unordered pick lets the stamp for those places differ between two
	// builds of the same source. The count is logged because the number is expected to grow, and should
	// be visible rather than inferred.
	for (const r of src
		.prepare(
			"SELECT id, MIN(ancestor_id) AS ancestor_id, COUNT(DISTINCT ancestor_id) AS n" +
				" FROM ancestors WHERE ancestor_placetype='region' GROUP BY id"
		)
		.iterate()) {
		regionOf.set(Number(r.id), Number(r.ancestor_id))

		if (Number(r.n) > 1) {
			multiRegion++
		}
	}

	progress(
		"region",
		`${regionOf.size.toLocaleString()} places carry a region` +
			(multiRegion ? ` (${multiRegion.toLocaleString()} carry more than one; stamped with the lowest id)` : "")
	)

	// The hot path — millions of clustered rows. Kept a single positional prepared statement (the fastest
	// node:sqlite insert) rather than a per-row query builder. Placeholders come from CANDIDATE_COLUMNS so
	// the column COUNT can't drift; the positional run() args below MUST stay in CANDIDATE_COLUMNS order.
	const insStage = out.prepare(`INSERT INTO cand_stage VALUES (${CANDIDATE_COLUMNS.map(() => "?").join(", ")})`)

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
		const cid = ccID(r.country as string | null)
		const ptid = ptID(r.placetype as string | null)
		const rid = regionOf.get(sid) ?? 0
		const pop = Number(r.pop) || 0
		const neg = -Math.log10(pop + 1)
		const name = String(r.name ?? "")
		const pkey = normalizeLocalityForKey(name)
		const lat = r.lat as number
		const lon = r.lon as number

		const a: PlaceAttrs = {
			cid,
			rid,
			ptid,
			name,
			lat,
			lon,
			mnLat: r.mnlat as number,
			mnLon: r.mnlon as number,
			mxLat: r.mxlat as number,
			mxLon: r.mxlon as number,
			pop,
			neg,
			pkey,
			imp: importance?.find(name, r.country as string | null, r.placetype as string | null, lat, lon) ?? null,
		}

		attrs.set(sid, a)

		if (pkey) {
			insStage.run(
				pkey,
				cid,
				rid,
				ptid,
				neg,
				sid,
				name,
				a.lat,
				a.lon,
				a.mnLat,
				a.mnLon,
				a.mxLat,
				a.mxLon,
				pop,
				1,
				a.imp
			)

			nPrim++
		}
	}

	out.exec("COMMIT")
	progress("primaries", `${nPrim.toLocaleString()} primaries; ${attrs.size.toLocaleString()} places`)

	if (importance) {
		progress(
			"importance",
			`${importance.matched.toLocaleString()} places scored; ` +
				`${importance.gated.toLocaleString()} refused (nearest same-name place > ${IMPORTANCE_JOIN_GATE_KM} km away)`
		)
	}

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
			isPrimary,
			a.imp
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

	/**
	 * Pass 4 — fold ONE postcode shard (`spr` rows with `placetype='postalcode'`) in, then pass 4b: the delivery-city
	 * aliases hanging off the same shard's `names` table.
	 *
	 * Extracted rather than inlined because the shard loop is self-contained — it shares only the staging statement and
	 * the code dictionaries with the passes above, and nothing after it reads anything it produces except the two
	 * counters it returns.
	 */
	const foldShard = (
		pcDB: string,
		shardPlacetype: "postalcode" | "locality"
	): { primaries: number; aliases: number } => {
		progress(shardPlacetype === "postalcode" ? "postcodes" : "localities", `reading ${pcDB}`)

		const pc = new DatabaseSync(pcDB, { readOnly: true })
		const pcPtid = ptID(shardPlacetype)
		// Per-shard, not the admin `attrs` map: pass 1 only ever sees the admin DB, so the alias pass
		// below has nothing to join against unless this primary loop records what it staged.
		const pcAttrs = new Map<number, PlaceAttrs>()
		let primaries = 0
		let aliases = 0

		out.exec("BEGIN")

		for (const r of pc
			.prepare(
				`SELECT id, name, country, latitude, longitude,
					min_latitude AS mnlat, min_longitude AS mnlon, max_latitude AS mxlat, max_longitude AS mxlon
				 FROM spr WHERE placetype = '${shardPlacetype}' AND latitude != 0 AND longitude != 0`
			)
			.iterate()) {
			const name = String(r.name ?? "")
			const key = normalizeLocalityForKey(name)

			if (!key) continue

			const lat = r.latitude as number
			const lon = r.longitude as number

			// region_id 0 (a postcode is unique by name+country — no same-name disambiguation); neg_rank 0
			// (no population). bbox = the postcode's own min/max (falls back to the centroid point).
			const a: PlaceAttrs = {
				cid: ccID(r.country as string | null),
				rid: 0,
				ptid: pcPtid,
				name,
				lat,
				lon,
				mnLat: (r.mnlat as number) || lat,
				mnLon: (r.mnlon as number) || lon,
				mxLat: (r.mxlat as number) || lat,
				mxLon: (r.mxlon as number) || lon,
				pop: 0,
				neg: 0,
				pkey: key,
				// A postcode has no toponym fame — nobody writes an encyclopedia article about SW1A 2AA — and
				// the score source carries no `postalcode` rows to join against anyway. NULL is the truthful
				// value: unmeasured, so the ranking key leaves postcode rows exactly where they were.
				imp: null,
			}

			pcAttrs.set(Number(r.id), a)
			stageRow(key, a, Number(r.id), 1)

			primaries++
		}

		out.exec("COMMIT")

		// --- pass 4b: postcode ALIAS names (#1495) ---
		//
		// The delivery-city names GeoNames supplies for a ZIP ("Brooklyn" for 11201) are written into
		// the shard's `names` table by `postcode/centroid-fills.ts`'s `geonamesNameFill`. Everything
		// downstream of `names` picked them up EXCEPT this build: `fts.ts` unions `spr.name` with every
		// `names` row into `place_search.alt_names`, so the FTS backend resolved "Brooklyn" → 11201
		// while the candidate backend — whose every row IS an exact-tier row — had no key for it at
		// all. Pass 2 does the equivalent fold for admin places, but reads the ADMIN `place_search`,
		// and `attrs` holds admin ids only, so a postcode shard could never reach it.
		//
		// Same discipline as pass 2: `is_primary = 0` (so `rankByPrimaryPreference` treats it as an
		// alias, not a canonical postcode name), the row stays denormalized onto the POSTCODE's own
		// spr_id/coords/bbox, and the display `name` stays the postcode — resolving "brooklyn" answers
		// with place 11201, it does not rename the place to its delivery city.
		const hasNames = pc.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='names'").get() !== undefined

		if (hasNames) {
			out.exec("BEGIN")

			for (const r of pc.prepare("SELECT id, name FROM names").iterate()) {
				const a = pcAttrs.get(Number(r.id))

				if (!a) continue

				const k = normalizeLocalityForKey(String(r.name ?? ""))

				// The postcode's own key is already staged as the primary; `INSERT OR IGNORE` at
				// materialization dedupes repeats, so this only skips the obvious self-alias.
				if (!k || k === a.pkey) continue

				stageRow(k, a, Number(r.id), 0)

				aliases++
			}

			out.exec("COMMIT")
		} else {
			// Never a silent zero: real shards come from `createUnifiedSchema`, which always creates
			// `names`. A shard without it has no alias surface to lose, but say so rather than reporting
			// "0 aliases" from a table that was never read.
			progress("postcode-aliases", `${pcDB} has no \`names\` table — no delivery-city aliases to fold`)
		}

		pc.close()

		return { primaries, aliases }
	}

	let nPostcode = 0
	let nPostcodeAlias = 0

	for (const pcDB of opts.postcodes ?? []) {
		const folded = foldShard(pcDB, "postalcode")

		nPostcode += folded.primaries
		nPostcodeAlias += folded.aliases
	}

	if (nPostcode > 0) {
		progress("postcodes", `${nPostcode.toLocaleString()} postcodes; ${nPostcodeAlias.toLocaleString()} aliases`)
	}

	let nLocality = 0

	for (const locDB of opts.localities ?? []) {
		const folded = foldShard(locDB, "locality")

		nLocality += folded.primaries
	}

	if (nLocality > 0) {
		progress("localities", `${nLocality.toLocaleString()} shard localities folded`)
	}

	// --- code dictionaries: typed batch inserts via kdb (a few hundred rows — Kysely is clean here) ---
	if (ccodes.size) {
		await kdb
			.insertInto("country_codes")
			.values([...ccodes].map(([code, id]) => ({ id, code })))
			.execute()
	}

	if (ptcodes.size) {
		await kdb
			.insertInto("placetype_codes")
			.values([...ptcodes].map(([placetype, id]) => ({ id, placetype })))
			.execute()
	}

	// --- materialize the clustered WITHOUT ROWID table (sorted insert → contiguous leaves) ---
	progress("cluster", "building clustered candidate table + VACUUM")
	// Column list + clustered-key order are sourced from CANDIDATE_COLUMNS (the first 6 ARE the PRIMARY
	// KEY) so the SELECT, the ORDER BY, and the table can't drift. The table comes from the shared
	// createCandidateTable().
	const cols = CANDIDATE_COLUMNS.join(", ")
	const keyOrder = CANDIDATE_COLUMNS.slice(0, 6).join(", ")
	await createCandidateTable(kdb)
	// OR IGNORE: an abbrev/alias can normalize to a place's primary key (same place, same rank) → any one
	// row. The bulk sorted INSERT…SELECT (clustered materialization) stays raw — a single hot bulk statement.
	out.exec(`INSERT OR IGNORE INTO candidate (${cols}) SELECT ${cols} FROM cand_stage ORDER BY ${keyOrder};`)
	await kdb.schema.dropTable("cand_stage").execute()
	// Typo-tolerant fallback index (the unified gazetteer's second mode): the exact name_key probe can't
	// recover misspellings, so FTS5-trigram over `name` lets the reader fuzzy-match on an exact+strip miss.
	progress("fts", "building FTS5-trigram fuzzy index")
	createCandidateFTS(out)
	// page_size MUST be set right before VACUUM: node:sqlite initializes the file at the 4096 default on
	// `new DatabaseSync`, so the creation-time pragma is a no-op — only a VACUUM rebuilds at the new size.
	// 8192 matches the sql.js-httpvfs 64 KiB request chunk cleanly (8 pages) and shallows the B-tree.
	out.exec("PRAGMA page_size=8192")
	out.exec("VACUUM")

	const { n: rows } = await kdb
		.selectFrom("candidate")
		.select((eb) => eb.fn.countAll<number>().as("n"))
		.executeTakeFirstOrThrow()

	src.close()
	await kdb.destroy()

	// closes the underlying `out` connection
	return {
		rows,
		places: attrs.size,
		primaries: nPrim,
		aliases: nAlias,
		abbrevs: nAbbr,
		postcodes: nPostcode,
		postcodeAliases: nPostcodeAlias,
		...(importance ? { importanceScored: importance.matched, importanceGated: importance.gated } : {}),
	}
}
