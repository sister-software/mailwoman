/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { COUNTRY_POPULATION } from "@mailwoman/codex/country"
import { pathExists } from "@mailwoman/core/fs/readers"
import { removePath } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { POPULATION_CORRECTIONS } from "#build/population-corrections"
import { explodeAliasBags } from "#candidate/alias-bags"
import { buildAncestorsSidecar } from "#candidate/ancestors/sidecar"
import { stageCountryDisplayNames } from "#candidate/country-display-names"
import { foldExtract } from "#candidate/extract-fold"
import { createCandidateFTS } from "#candidate/fts"
import { IMPORTANCE_JOIN_RADIUS_KM, loadImportanceIndex } from "#candidate/importance"
import { GLOSS_KEY_THRESHOLD, stampNameRoles } from "#candidate/name-roles"
import type { PlaceAttrs } from "#candidate/place-attrs"
import {
	CANDIDATE_COLUMNS,
	createCandidateStagingTables,
	createCandidateTable,
	type CandidateDatabase,
} from "#candidate/schema"
import { createCapitalTable } from "#capital-schema"
import type { CapitalPoint } from "#capitals"
import { resurrectCurrencyHoles } from "#currency-backfill"
import type { WOFDatabase } from "#schema"
import { normalizeLocalityForKey } from "#street/normalize"

/**
 * Re-exports the country display-name staging pass from the candidate build's public module.
 */
export { stageCountryDisplayNames } from "#candidate/country-display-names"
/**
 * Re-exports the gloss detector's excluded placetypes and default key-count threshold.
 */
export { GLOSS_EXCLUDED_PLACETYPES, GLOSS_KEY_THRESHOLD } from "#candidate/name-roles"
/**
 * Re-exports the per-place record that every candidate staging pass writes its rows from.
 */
export type { PlaceAttrs } from "#candidate/place-attrs"

/**
 * Options for {@link buildCandidateTable}.
 */
export interface BuildCandidateOptions {
	/**
	 * The source WOF admin database.
	 *
	 * It must have the `spr`, `place_population`, `place_search`, `place_abbr` and `ancestors` tables.
	 */
	input: PathBuilderLike

	/**
	 * The candidate database to write, replacing any existing file.
	 */
	output: PathBuilderLike

	/**
	 * The capital reference entries to store in the artifact's `capital` table.
	 *
	 * The caller passes them because this published module must not read repo paths.
	 * Without them the table is not created, and the capital loader falls back
	 * to the repo's `capitals-v1.json`.
	 */
	capitals?: readonly CapitalPoint[]

	/**
	 * Postcode extract databases whose located `spr` rows become `postalcode` candidate rows.
	 *
	 * Each extract's `names` table becomes aliases, such as the delivery city "Brooklyn" for 11201.
	 */
	postcodes?: readonly PathBuilderLike[]

	/**
	 * Locality extract databases whose located `spr` rows become `locality`
	 * candidate rows with zero population.
	 *
	 * Their `names` tables become non-primary aliases.
	 * When an extract's `ancestors` table gives a row's region, the row gets
	 * that region's scope and closure rows.
	 * Other rows stay unscoped.
	 */
	localities?: readonly PathBuilderLike[]

	/**
	 * A WOF admin database with a `place_importance` table, which supplies the `importance` column.
	 *
	 * Rows join on name key, country and placetype, then on the nearest centroid.
	 * Without this option every row's `importance` is NULL, and consumers treat NULL as unmeasured.
	 */
	importance?: PathBuilderLike

	/**
	 * Settings for restoring deprecated WOF places that have no successor and have a GeoNames attestation.
	 *
	 * A deprecated place is restored only when no live row of the same name lies within 10 km and
	 * a GeoNames populated place with the same folded name and at least 1,000 people lies within 10 km.
	 * Countries without `<cc>.txt` under `geonamesDir` are skipped and reported.
	 */
	currencyBackfill?: {
		geonamesDir: PathBuilderLike
		countries: readonly string[]

		/**
		 * The deprecated placetypes eligible for restoration.
		 * The default is `locality`.
		 */
		deadPlacetypes?: readonly string[]
	}

	/**
	 * Receives a phase name and a message as each build step runs.
	 */
	onProgress?: (phase: string, message: string) => void

	/**
	 * The key-count threshold for the gloss anomaly detector.
	 * The default is {@link GLOSS_KEY_THRESHOLD}.
	 *
	 * Tests override it with a value sized for fixtures.
	 */
	glossKeyThreshold?: number
}

/**
 * Row and place counts from each stage of {@link buildCandidateTable}.
 */
export interface BuildCandidateResult {
	rows: number
	places: number
	primaries: number
	aliases: number

	/**
	 * The count of region aliases dropped because another region in the same
	 * country uses the name as its official name.
	 *
	 * The count is always zero for a source without a `names` table.
	 */
	regionOfficialRefused: number
	abbrevs: number
	postcodes: number

	/**
	 * The count of aliases added to postcode rows from the extracts' `names` tables.
	 *
	 * An extract without a `names` table is reported through `onProgress`.
	 */
	postcodeAliases: number

	/**
	 * The count of closure rows written to the `candidate_ancestor` sidecar,
	 * including rows from locality extracts.
	 */
	ancestorRows: number

	/**
	 * The count of places with at least one closure row.
	 */
	ancestorPlaces: number

	/**
	 * The count of places that received a pre/post interval label, which equals
	 * the node count of the canonical-parent forest.
	 *
	 * Containment against a place outside the forest is unknown.
	 */
	intervalPlaces: number

	/**
	 * The count of places that received an `importance` score.
	 *
	 * It is `undefined` when no score source was given.
	 */
	importanceScored?: number

	/**
	 * The count of places that matched a scored group by name key, country and placetype
	 * but whose nearest scored centroid lay beyond {@link IMPORTANCE_JOIN_RADIUS_KM}.
	 *
	 * A large change between rebuilds means the score source and the admin source have diverged.
	 */
	importanceFiltered?: number

	/**
	 * The count of alias rows the gloss anomaly detector stamped `name_role = 'gloss'`.
	 */
	roleGloss: number

	/**
	 * The count of alias rows stamped `name_role = 'abbr'`, which marks a variant in the official language.
	 */
	roleAbbr: number

	/**
	 * The count of admin places whose staged key count reached the gloss key threshold.
	 * It is the denominator for `keyTailWithRole`.
	 */
	keyTailPlaces: number

	/**
	 * The count of places in `keyTailPlaces` with at least one stamped role row.
	 */
	keyTailWithRole: number
}

/**
 * Builds the candidate lookup database from a WOF admin database, replacing any
 * existing output, and adds its FTS5 trigram index for fuzzy lookup.
 */
export async function buildCandidateTable(opts: BuildCandidateOptions): Promise<BuildCandidateResult> {
	const progress = opts.onProgress ?? (() => {})

	if (await pathExists(opts.output)) {
		await removePath(opts.output)
	}

	using src = new DatabaseClient<WOFDatabase>(opts.input, { readOnly: true })
	await using kdb = new DatabaseClient<CandidateDatabase>(opts.output)

	kdb.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")

	await createCandidateStagingTables(kdb)

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
		progress("importance", "no score source given — `importance` will be NULL on every row")
	}

	progress("region", "loading region ancestry")
	const regionOf = new Map<number, number>()
	let multiRegion = 0

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

	const insStage = kdb.prepare(`INSERT INTO cand_stage VALUES (${CANDIDATE_COLUMNS.map(() => "?").join(", ")})`)

	progress("primaries", "indexing place names")
	const attrs = new Map<number, PlaceAttrs>()
	let nPrim = 0
	kdb.exec("BEGIN")

	for (const r of src
		.prepare(
			`SELECT s.id AS id, s.name AS name, s.placetype AS placetype, s.country AS country,
				s.latitude AS lat, s.longitude AS lon,
				s.min_latitude AS mnlat, s.min_longitude AS mnlon, s.max_latitude AS mxlat, s.max_longitude AS mxlon,
				pp.population AS pop
			 FROM spr s LEFT JOIN place_population pp ON pp.id = s.id
			 WHERE s.is_current != 0 AND s.is_deprecated = 0`
		)
		.iterate()) {
		const sid = Number(r.id)
		const cid = ccID(r.country as string | null)
		const ptid = ptID(r.placetype as string | null)
		const rid = regionOf.get(sid) ?? 0

		const wofPop = r.pop === null || r.pop === undefined ? null : Number(r.pop)

		const pop =
			POPULATION_CORRECTIONS[sid]?.population ??
			(wofPop === null && r.placetype === "country" ? (COUNTRY_POPULATION[String(r.country ?? "")] ?? null) : wofPop)

		const neg = -Math.log10((pop ?? 0) + 1)
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
				`${importance.refused.toLocaleString()} refused (nearest same-name place > ${IMPORTANCE_JOIN_RADIUS_KM} km away)`
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

	if (opts.currencyBackfill) {
		const nBackfill = await resurrectCurrencyHoles({
			src,
			tx: kdb,
			geonamesDir: opts.currencyBackfill.geonamesDir,
			countries: opts.currencyBackfill.countries,
			...(opts.currencyBackfill.deadPlacetypes ? { deadPlacetypes: opts.currencyBackfill.deadPlacetypes } : {}),
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
		progress("currency-backfill", "not configured — deprecated-no-successor holes stay dead (#1737)")
	}

	progress("aliases", "exploding alias bags")

	const { nAlias, keyCounts, regionOfficialRefused } = explodeAliasBags(src, kdb, attrs, stageRow, {
		regionPlacetypeID: ptID("region"),
		ccID,
	})

	progress(
		"aliases",
		`${nAlias.toLocaleString()} aliases` +
			(regionOfficialRefused
				? `; ${regionOfficialRefused.toLocaleString()} region aliases refused as another region's official name`
				: "")
	)

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

	const sidecar = await buildAncestorsSidecar({ src, out: kdb, attrs, ptID, progress })

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
	let nLocalityScoped = 0
	let nLocalityAncestor = 0

	for (const locDB of opts.localities ?? []) {
		const folded = foldExtract({
			out: kdb,
			extractPath: locDB,
			extractPlacetype: "locality",
			ccID,
			ptID,
			stageRow,
			attrs,
			progress,
		})

		nLocality += folded.primaries
		nLocalityScoped += folded.scoped
		nLocalityAncestor += folded.ancestorRows
	}

	if (nLocality > 0) {
		progress(
			"localities",
			`${nLocality.toLocaleString()} extract localities folded` +
				(nLocalityScoped
					? `; ${nLocalityScoped.toLocaleString()} carry a region scope (${nLocalityAncestor.toLocaleString()} closure rows)`
					: "")
		)
	}

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
					keys: stringifyJSON(entry.k),
				}))
			)
			.execute()

		progress("capitals", `${opts.capitals.length.toLocaleString()} capital-reference rows carried in-artifact`)
	}

	progress("cluster", "building clustered candidate table + VACUUM")

	const cols = CANDIDATE_COLUMNS.join(", ")
	const keyOrder = CANDIDATE_COLUMNS.slice(0, 6).join(", ")
	await createCandidateTable(kdb)

	kdb.exec(`INSERT OR IGNORE INTO candidate (${cols}) SELECT ${cols} FROM cand_stage ORDER BY ${keyOrder};`)
	await kdb.schema.dropTable("cand_stage").execute()

	progress("fts", "building FTS5-trigram fuzzy index")
	createCandidateFTS(kdb)

	kdb.exec("PRAGMA page_size=8192")
	kdb.exec("VACUUM")

	const { n: rows } = await kdb
		.selectFrom("candidate")
		.select((eb) => eb.fn.countAll<number>().as("n"))
		.executeTakeFirstOrThrow()

	return {
		rows,
		places: attrs.size,
		primaries: nPrim,
		aliases: nAlias,
		regionOfficialRefused,
		abbrevs: nAbbr,
		postcodes: nPostcode,
		postcodeAliases: nPostcodeAlias,
		ancestorRows: sidecar.ancestorRows + nLocalityAncestor,
		ancestorPlaces: sidecar.ancestorPlaces + nLocalityScoped,
		intervalPlaces: sidecar.intervalPlaces,
		...roles,
		...(importance ? { importanceScored: importance.matched, importanceFiltered: importance.refused } : {}),
	}
}
