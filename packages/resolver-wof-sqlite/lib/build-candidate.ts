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
 *   discipline the address-point extract uses, so build/query stay consistent by construction.
 *
 *   Measured (2026-06-20, vs the 2.6 GB full-DB FTS): ~5 M rows; ~12 range fetches per 8-query
 *   session (the full DB needs 243); US locality 96.8% (region bbox), EU coord parity 88.6%.
 *
 *   #28 adds one more denormalized field, `importance` — the toponym-fame prior that decides a BARE
 *   city name, joined in from a separate score source by name rather than by id (see
 *   `candidate-importance.ts`, which owns that join and explains why the id would be wrong). It is
 *   optional: without {@link BuildCandidateOptions.importance} the column is NULL on every row, which
 *   the consumer reads as unmeasured and ignores.
 *
 *   The build also materializes the ANCESTORS SIDECAR (`candidate_ancestor` closure rows +
 *   `candidate_interval` pre/post labels) from the source `ancestors` table — the containment
 *   lineage behind {@link WOFCandidateTableLookup.ancestors} and the admin-coherence check.
 *   `candidate-ancestors-schema.ts` owns the encoding decision and the DAG/absence semantics.
 */

import { COUNTRY_POPULATION } from "@mailwoman/codex/country"
import { pathExists } from "@mailwoman/core/fs/readers"
import { removePath } from "@mailwoman/core/fs/writers"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { createCandidateFTS } from "#candidate-fts"
import { IMPORTANCE_JOIN_GATE_KM, loadImportanceIndex } from "#candidate-importance"
import {
	CANDIDATE_COLUMNS,
	createCandidateStagingTables,
	createCandidateTable,
	type CandidateDatabase,
} from "#candidate-schema"
import { explodeAliasBags } from "#candidate/alias-bags"
import { buildAncestorsSidecar } from "#candidate/ancestors-sidecar"
import { stageCountryDisplayNames } from "#candidate/country-display-names"
import { foldExtract } from "#candidate/extract-fold"
import { GLOSS_KEY_THRESHOLD, stampNameRoles } from "#candidate/name-roles"
import type { PlaceAttrs } from "#candidate/place-attrs"
import { createCapitalTable } from "#capital-schema"
import type { CapitalPoint } from "#capitals"
import { resurrectCurrencyHoles } from "#currency-backfill"
import type { WOFDatabase } from "#schema"
import { normalizeLocalityForKey } from "#street-normalize"

// The build's contract is this module path; the passes behind it live in `./candidate/`. Re-exported
// here so a consumer never has to know which pass owns which name.
export { stageCountryDisplayNames } from "#candidate/country-display-names"
export { GLOSS_EXCLUDED_PLACETYPES, GLOSS_KEY_THRESHOLD } from "#candidate/name-roles"
export type { PlaceAttrs } from "#candidate/place-attrs"

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
	 * The capital-status reference entries (#1880) to carry in-artifact — the parsed `data/gazetteer/capitals-v1.json`
	 * entries, passed by the CALLER because this module publishes to npm and must not read repo-root paths. Absent → the
	 * `capital` table is not created, and the session loader falls back to the repo file where one exists.
	 */
	capitals?: readonly CapitalPoint[]
	/**
	 * Optional postcode extracts (`spr` rows with `placetype='postalcode'` + real coords, e.g. postalcode-us.db) — folded
	 * in as `postalcode` candidate rows so `findPlace(postalcode)` resolves a ZIP directly (the demo's primary postcode
	 * path; the postcode-*.bin anchor stays the fallback). Matches the slim wof-hot.db, which took one such postcode DB.
	 *
	 * Each extract's `names` table is folded in too (#1495) — that's where the GeoNames delivery-city names live
	 * ("Brooklyn" for 11201), and they were previously reachable only through FTS.
	 */
	postcodes?: string[]
	/**
	 * Optional LOCALITY extracts (`spr` rows with `placetype='locality'` + real coords, e.g. localities-nz-linz.db — the
	 * #1564 NZ suburb tier) — folded through the same extract loop as the postcode extracts, staged as `locality`
	 * candidate rows with no region scope and UNMEASURED population (`neg_rank 0`: a extract row ranks behind any
	 * populated namesake and wins only where its key is the answer). Each extract's `names` table folds as aliases,
	 * `is_primary = 0`, same as the delivery-city pass.
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
	 * Cross-source currency backfill (#1737). WOF carries deprecated-with-no-successor records for real, populated
	 * settlements (Rochester Kent, Aldershot, Telford — 120 GB localities alone), and the currency filter correctly drops
	 * them, leaving holes no ranking can fill. When this option is set, pass 1c resurrects a dead locality ONLY under
	 * three gates, positive evidence throughout: no live same-name row of any placetype near the dead record (a distant
	 * same-name row is a NAMESAKE and does not block — Rochester, Northumberland pop 318 must not veto Rochester, Kent);
	 * an independent GeoNames P-class attestation of the same folded name within {@link CURRENCY_BACKFILL_RADIUS_KM}; and
	 * the attestor at or above {@link CURRENCY_BACKFILL_POP_FLOOR}. The staged row keeps the real WOF id, name, centroid
	 * and bbox — GeoNames only ATTESTS the place and supplies the population that lets it stand in prominence races.
	 * `countries` are judged only where `<cc>.txt` exists under `geonamesDir`; absent dumps are skipped loudly.
	 */
	currencyBackfill?: { geonamesDir: string; countries: readonly string[] }
	/**
	 * Optional progress callback for CLI / test introspection.
	 */
	onProgress?: (phase: string, message: string) => void
	/**
	 * Key-count threshold for the gloss anomaly detector — {@link GLOSS_KEY_THRESHOLD} unless a test passes a
	 * fixture-scale value. The production number is the #1730 sweep's own cut (4,000 places at >= 50 keys).
	 */
	glossKeyThreshold?: number
}

export interface BuildCandidateResult {
	rows: number
	places: number
	primaries: number
	aliases: number
	abbrevs: number
	postcodes: number
	/**
	 * Delivery-city (and other `names`-table) aliases folded onto postcode rows — #1495. Zero here means the extracts
	 * carried no alias names, NOT that the pass was skipped: a extract with no `names` table reports that separately
	 * through `onProgress`.
	 */
	postcodeAliases: number
	/**
	 * Closure rows in the `candidate_ancestor` sidecar (see candidate-ancestors-schema.ts). Zero means the source
	 * `ancestors` table contributed nothing within the resolvable placetypes — a finding, reported rather than implied.
	 */
	ancestorRows: number
	/**
	 * Places carrying at least one closure row.
	 */
	ancestorPlaces: number
	/**
	 * Places that received a pre/post interval label — the canonical-parent forest's node count. Places outside it (no
	 * recorded ancestry, extract rows, cycle-skipped) have NO label: containment against them is unverifiable, never
	 * false.
	 */
	intervalPlaces: number
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
	/**
	 * Alias rows stamped `name_role = 'gloss'` — the anomaly detector's certain core (#1730).
	 */
	roleGloss: number
	/**
	 * Alias rows stamped `name_role = 'abbr'` — the variant-in-official-language provenance signal (#1730/#936).
	 */
	roleAbbr: number
	/**
	 * Admin places whose staged key count reached {@link GLOSS_KEY_THRESHOLD} — the sweep's tail, reported so the stamped
	 * fraction has its denominator.
	 */
	keyTailPlaces: number
	/**
	 * Of {@link BuildCandidateResult.keyTailPlaces}, how many carry at least one stamped role row.
	 */
	keyTailWithRole: number
}

export async function buildCandidateTable(opts: BuildCandidateOptions): Promise<BuildCandidateResult> {
	const progress = opts.onProgress ?? (() => {})

	if (await pathExists(opts.output)) {
		await removePath(opts.output)
	}

	using src = new DatabaseClient<WOFDatabase>(opts.input, { readOnly: true })
	await using kdb = new DatabaseClient<CandidateDatabase>(opts.output)
	// Build-tuning pragmas (raw — Kysely doesn't model PRAGMA). The code dictionaries + the transient
	// staging table come from the SHARED schema DDL, so they can't drift from {@link CandidateDatabase}.
	kdb.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")

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
	const insStage = kdb.prepare(`INSERT INTO cand_stage VALUES (${CANDIDATE_COLUMNS.map(() => "?").join(", ")})`)

	// --- pass 1: primaries (and the per-place attrs the alias/abbrev passes reuse) ---
	progress("primaries", "indexing place names")
	const attrs = new Map<number, PlaceAttrs>()
	let nPrim = 0
	kdb.exec("BEGIN")

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
		// A zero population on a COUNTRY row is a WOF absence artifact, never a real zero — 147 of 237
		// primary country records carried none (measured 2026-08-18, #1650), which ranked those nations
		// below any namesake hamlet in every prominence race ("Georgia" → Georgia VT). The codex table is
		// the secondary source; a country absent from it too stays at zero honestly.
		const wofPop = Number(r.pop) || 0
		const pop = wofPop === 0 && r.placetype === "country" ? (COUNTRY_POPULATION[String(r.country ?? "")] ?? 0) : wofPop
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
				a.imp,
				null
			)

			nPrim++
		}
	}

	kdb.exec("COMMIT")
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
			a.imp,
			null
		)
	}

	// --- pass 1b: country surfaces across scripts (#1678 thread 1) — see stageCountryDisplayNames ---
	// Never a silent zero: a runtime whose ICU lacks these locales degrades to fewer surfaces, and the count is how a
	// reader tells that apart from the pass not having run.
	progress(
		"country-display-names",
		`${stageCountryDisplayNames({
			attrs,
			iso2ByID: new Map([...ccodes].map(([code, id]) => [id, code])),
			countryPtID: ptID("country"),
			stageRow,
			tx: kdb,
		}).toLocaleString()} country surfaces`
	)

	// --- pass 1c: cross-source currency backfill (#1737 — resurrectCurrencyHoles owns the gates). Runs BEFORE
	// the alias pass so a resurrected place's alt names explode like any primary's. ---
	if (opts.currencyBackfill) {
		const nBackfill = await resurrectCurrencyHoles({
			src,
			tx: kdb,
			geonamesDir: opts.currencyBackfill.geonamesDir,
			countries: opts.currencyBackfill.countries,
			attrs,
			ccID,
			ptID,
			regionOf,
			importance,
			stageRow,
			progress,
		})

		progress("currency-backfill", `${nBackfill.toLocaleString()} resurrections staged`)
	} else {
		// Never a silent absence: a build without the option leaves the deprecated-no-successor holes dead,
		// and the log must say so rather than leave it inferable only from a missing row.
		progress("currency-backfill", "not configured — deprecated-no-successor holes stay dead (#1737)")
	}

	// --- pass 2: distinct normalized aliases from place_search.alt_names (explodeAliasBags owns the loop) ---
	progress("aliases", "exploding alias bags")
	const { nAlias, keyCounts } = explodeAliasBags(src, kdb, attrs, stageRow)
	progress("aliases", `${nAlias.toLocaleString()} aliases`)

	// --- pass 3: region abbreviations (place_abbr) ---
	let nAbbr = 0
	kdb.exec("BEGIN")

	for (const r of src.prepare("SELECT id, abbr FROM place_abbr").iterate()) {
		const a = attrs.get(Number(r.id))

		if (!a) continue
		const k = normalizeLocalityForKey(String(r.abbr ?? ""))

		if (!k) continue
		stageRow(k, a, Number(r.id), 1)

		nAbbr++
	}

	kdb.exec("COMMIT")
	progress("abbrevs", `${nAbbr.toLocaleString()} abbrevs`)

	// --- pass 3b: name roles (#1730 prototype — stampNameRoles owns the detectors) ---
	// Independent of the sidecar below: this writes `cand_stage.name_role`, that writes the ancestor and
	// interval tables, and neither reads the other's output. Ordered by label only.
	const roles = stampNameRoles({
		src,
		out: kdb,
		attrs,
		keyCounts,
		glossThreshold: opts.glossKeyThreshold ?? GLOSS_KEY_THRESHOLD,
		ptcodes,
		ccodes,
		progress,
	})

	// --- pass 3c: the ancestors sidecar (candidate-ancestors-schema.ts owns the encoding decision) ---
	const sidecar = await buildAncestorsSidecar({ src, out: kdb, attrs, ptID, progress })

	// --- pass 4 + 4b: postcode and locality extracts (foldExtract owns the per-extract loop) ---
	let nPostcode = 0
	let nPostcodeAlias = 0

	for (const pcDB of opts.postcodes ?? []) {
		const folded = foldExtract({
			out: kdb,
			extractPath: pcDB,
			extractPlacetype: "postalcode",
			ccID,
			ptID,
			stageRow,
			progress,
		})

		nPostcode += folded.primaries
		nPostcodeAlias += folded.aliases
	}

	if (nPostcode > 0) {
		progress("postcodes", `${nPostcode.toLocaleString()} postcodes; ${nPostcodeAlias.toLocaleString()} aliases`)
	}

	let nLocality = 0

	for (const locDB of opts.localities ?? []) {
		const folded = foldExtract({
			out: kdb,
			extractPath: locDB,
			extractPlacetype: "locality",
			ccID,
			ptID,
			stageRow,
			progress,
		})

		nLocality += folded.primaries
	}

	if (nLocality > 0) {
		progress("localities", `${nLocality.toLocaleString()} extract localities folded`)
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

	// --- capital-status reference (#1880's distribution home) — cold, small (~3.7k rows), typed ---
	if (opts.capitals?.length) {
		await createCapitalTable<CandidateDatabase>(kdb)

		await kdb
			.insertInto("capital")
			.values(
				opts.capitals.map((entry) => ({
					country: entry.country,
					latitude: entry.latitude,
					longitude: entry.longitude,
					level: entry.level,
					keys: JSON.stringify(entry.k),
				}))
			)
			.execute()

		progress("capitals", `${opts.capitals.length.toLocaleString()} capital-reference rows carried in-artifact`)
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
	kdb.exec(`INSERT OR IGNORE INTO candidate (${cols}) SELECT ${cols} FROM cand_stage ORDER BY ${keyOrder};`)
	await kdb.schema.dropTable("cand_stage").execute()
	// Typo-tolerant fallback index (the unified gazetteer's second mode): the exact name_key probe can't
	// recover misspellings, so FTS5-trigram over `name` lets the reader fuzzy-match on an exact+strip miss.
	progress("fts", "building FTS5-trigram fuzzy index")
	createCandidateFTS(kdb)
	// page_size MUST be set right before VACUUM: node:sqlite initializes the file at the 4096 default on
	// `new DatabaseSync`, so the creation-time pragma is a no-op — only a VACUUM rebuilds at the new size.
	// 8192 matches the sql.js-httpvfs 64 KiB request chunk cleanly (8 pages) and shallows the B-tree.
	kdb.exec("PRAGMA page_size=8192")
	kdb.exec("VACUUM")

	const { n: rows } = await kdb
		.selectFrom("candidate")
		.select((eb) => eb.fn.countAll<number>().as("n"))
		.executeTakeFirstOrThrow()

	// closes the underlying `out` connection
	return {
		rows,
		places: attrs.size,
		primaries: nPrim,
		aliases: nAlias,
		abbrevs: nAbbr,
		postcodes: nPostcode,
		postcodeAliases: nPostcodeAlias,
		ancestorRows: sidecar.ancestorRows,
		ancestorPlaces: sidecar.ancestorPlaces,
		intervalPlaces: sidecar.intervalPlaces,
		...roles,
		...(importance ? { importanceScored: importance.matched, importanceGated: importance.gated } : {}),
	}
}
