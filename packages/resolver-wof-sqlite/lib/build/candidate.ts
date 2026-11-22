// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { COUNTRY_POPULATION } from "@mailwoman/codex/country"
import { bareAdminName } from "@mailwoman/codex/country/bare-admin-names"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { removePath } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { isOverturePartID } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { POPULATION_CORRECTIONS } from "#build/population-corrections"
import { explodeAliasBags } from "#candidate/alias-bags"
import { buildAncestorsSidecar } from "#candidate/ancestors/sidecar"
import { stageBareAdminNames } from "#candidate/bare-admin-names"
import { stageCountryDisplayNames } from "#candidate/country-display-names"
import { stageExtractRows } from "#candidate/extract-rows"
import { createCandidateFTS } from "#candidate/fts"
import { IMPORTANCE_JOIN_RADIUS_KM, loadImportanceIndex } from "#candidate/importance"
import { applyCandidateKeyFold, type CandidateKeyFold } from "#candidate/key-fold"
import { GLOSS_KEY_THRESHOLD, stampNameRoles } from "#candidate/name-roles"
import { refuseNicknamesOfNamesakes } from "#candidate/nickname-namesakes"
import { stageOvertureTwins } from "#candidate/overture-twins"
import type { PlaceAttrs } from "#candidate/place-attrs"
import {
	CANDIDATE_COLUMNS,
	createCandidatePostcodePlaceIndex,
	createCandidateStagingTables,
	createCandidateTable,
	type CandidateDatabase,
	POSTCODE_PLACETYPE,
} from "#candidate/schema"
import { createCapitalTable } from "#capital-schema"
import type { CapitalPoint } from "#capitals"
import type { WOFDatabase } from "#schema"
import { normalizeLocalityForKey } from "#street/normalize"

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
	 * The caller supplies these entries because this published module cannot read repository paths.
	 * The builder creates no `capital` table when the caller omits them.
	 *
	 * The capital loader then falls back to the repository's `capitals-v1.json`.
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
	 * A WOF admin database with a `place_importance` table supplies the `importance` column.
	 *
	 * Rows join on name key, country and placetype, then on the nearest centroid.
	 * Without this option every row's `importance` is NULL.
	 * Consumers treat NULL as unmeasured.
	 */
	importance?: PathBuilderLike

	/**
	 * Rank each place with no population by the importance database's
	 * `place_population_estimate`, when it has an estimate there.
	 *
	 * The estimate sets `neg_rank` only; `population` stays NULL, because no source measured it.
	 *
	 * Requires {@link BuildCandidateOptions.importance}, built with sub-locality estimates.
	 *
	 * @defaultValue false
	 */
	populationEstimates?: boolean

	/**
	 * Receives a phase name and a message as each build step runs.
	 */
	onProgress?: (phase: string, message: string) => void

	/**
	 * The key-count threshold for the gloss anomaly detector.
	 *
	 * Tests override it with a value sized for fixtures.
	 *
	 * @defaultValue {@linkcode GLOSS_KEY_THRESHOLD}
	 */
	glossKeyThreshold?: number

	/**
	 * Folds applied to every `name_key` after `normalizeLocalityForKey`, recorded in
	 * the artifact so its reader folds query keys the same way.
	 *
	 * @defaultValue none
	 */
	keyFolds?: readonly CandidateKeyFold[]
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
	 * The count of alias rows staged as a name's key with its apostrophe-like marks
	 * removed (`hawaii` for `Hawaiʻi`), which `aliases` excludes.
	 */
	markFreeAliases: number

	/**
	 * The count of region aliases dropped because another region in the same
	 * country uses the name as its official name.
	 *
	 * The count is always zero for a source without a `names` table.
	 */
	regionOfficialRefused: number

	/**
	 * The count of alias rows from a colloquial or unclassified name dropped
	 * because a populated place holds the same key by a real name.
	 *
	 * The count is always zero for a source without a `names` table.
	 */
	nicknameRefused: number
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
	 * The count of places that received a pre/post interval label.
	 * It equals the node count of the canonical-parent forest.
	 *
	 * Containment against a place outside the forest is unknown.
	 */
	intervalPlaces: number

	/**
	 * The count of places that received an `importance` score.
	 *
	 * It is `null` when no score source was given.
	 */
	importanceScored: number | null

	/**
	 * The count of places that matched a scored group by name key, country and placetype
	 * but whose nearest scored centroid lay beyond {@link IMPORTANCE_JOIN_RADIUS_KM}.
	 *
	 * A large change between rebuilds means the score source and the admin source have diverged.
	 */
	importanceFiltered: number | null

	/**
	 * The count of places ranked by a population estimate, or `null` when estimates weren't asked for.
	 */
	populationEstimated: number | null

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

	/**
	 * The Overture divisions the admin database matched to a WOF record, copied into
	 * `overture_wof_match`, or null when the admin database predates that table.
	 */
	overtureMatches: number | null

	/**
	 * The matched divisions' staged rows dropped on keys their WOF record holds,
	 * or null with `overtureMatches`.
	 */
	overtureTwinRowsDropped: number | null
}

/**
 * Each place's region from the admin database's `ancestors`, the lowest id
 * when it has more than one, with the count of places that have more than one.
 */
function loadRegionAncestry(src: DatabaseClient<WOFDatabase>): { regionOf: Map<number, number>; multiRegion: number } {
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

	return { regionOf, multiRegion }
}

/**
 * The two staging passes that delete rows by another place's rows, in order:
 * the nickname refusal, then the Overture twins.
 *
 * The twins pass compares with the WOF rows the refusal keeps.
 */
async function refuseNicknamesAndTwins(
	src: DatabaseClient<WOFDatabase>,
	kdb: DatabaseClient<CandidateDatabase>,
	attrs: Map<number, PlaceAttrs>,
	progress: (phase: string, message: string) => void
): Promise<{
	nicknames: ReturnType<typeof refuseNicknamesOfNamesakes>
	twins: Awaited<ReturnType<typeof stageOvertureTwins>>
}> {
	const nicknames = refuseNicknamesOfNamesakes(src, kdb, attrs)

	progress(
		"nicknames",
		`${nicknames.rows.toLocaleString()} colloquial or unclassified alias rows refused on ` +
			`${nicknames.keys.toLocaleString()} keys a populated place holds by a real name`
	)

	const twins = await stageOvertureTwins(src, kdb)

	if (twins) {
		progress(
			"overture-twins",
			`${twins.matches.toLocaleString()} Overture divisions matched to a WOF record. ` +
				`${twins.rowsDropped.toLocaleString()} of their rows dropped on keys the WOF record holds`
		)
	}

	return { nicknames, twins }
}

/**
 * Builds the candidate lookup database from a WOF admin database and replaces any existing output.
 * The builder adds an FTS5 trigram index for fuzzy lookup.
 */
// repo-health-ignore export-name-affix -- writes candidate.db, and the gazetteer
// pipeline's buildCandidate runs a whole build around it
export async function buildCandidateTable(opts: BuildCandidateOptions): Promise<BuildCandidateResult> {
	const progress = opts.onProgress ?? (() => {})

	if (await pathExists(opts.output)) {
		await removePath(opts.output)
	}

	using src = new DatabaseClient<WOFDatabase>(opts.input, { readOnly: true })
	using kdb = new DatabaseClient<CandidateDatabase>(opts.output)

	kdb.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")

	await createCandidateStagingTables(kdb)

	const ccodes = new Map<string, number>()
	const ptcodes = new Map<string, number>()

	const ccID = (code: string | null): number => {
		const c = (code || "??").toUpperCase()
		let id = ccodes.get(c)

		if (typeof id !== "number") {
			id = ccodes.size
			ccodes.set(c, id)
		}

		return id
	}

	const ptID = (pt: string | null): number => {
		const p = pt || ""
		let id = ptcodes.get(p)

		if (typeof id !== "number") {
			id = ptcodes.size
			ptcodes.set(p, id)
		}

		return id
	}

	let importance: ReturnType<typeof loadImportanceIndex> | null = null

	if (opts.importance) {
		progress("importance", `loading place_importance from ${opts.importance}`)
		importance = loadImportanceIndex(opts.importance, { populationEstimates: opts.populationEstimates === true })

		progress(
			"importance",
			`${importance.stats.places.toLocaleString()} scored places in ${importance.stats.keys.toLocaleString()} (name, country, placetype) groups` +
				(importance.stats.unkeyable ? `; ${importance.stats.unkeyable.toLocaleString()} unkeyable names skipped` : "") +
				(typeof importance.stats.estimates === "number"
					? `; ${importance.stats.estimates.toLocaleString()} population estimates to rank unmeasured places by`
					: "")
		)
	} else if (opts.populationEstimates) {
		throw new Error("buildCandidateTable: populationEstimates reads the importance database; pass importance too")
	} else {
		progress("importance", "no score source given — `importance` will be NULL on every row")
	}

	progress("region", "loading region ancestry")
	const { regionOf, multiRegion } = loadRegionAncestry(src)

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

		const wofPop = r.pop === null || !r.pop ? null : Number(r.pop)

		const pop =
			POPULATION_CORRECTIONS[sid]?.population ??
			(wofPop === null && r.placetype === "country" ? (COUNTRY_POPULATION[String(r.country ?? "")] ?? null) : wofPop)

		const neg = -Math.log10((pop ?? importance?.estimatedPopulation(sid) ?? 0) + 1)
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
			imp:
				importance?.find(
					name,
					r.country as string | null,
					r.placetype as string | null,
					lat,
					lon,
					isOverturePartID(sid)
				) ?? null,
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

	progress(
		"bare-admin-names",
		`${stageBareAdminNames({
			attrs,
			iso2ByID: new Map([...ccodes].map(([code, id]) => [id, code])),
			stageRow,
			tx: kdb,
		}).toLocaleString()} bare admin names`
	)

	progress("aliases", "exploding alias bags")

	const iso2ByCountryID = new Map([...ccodes].map(([code, id]) => [id, code]))

	const { nAlias, nBare, nMarkFree, keyCounts, regionOfficialRefused } = explodeAliasBags(src, kdb, attrs, stageRow, {
		regionPlacetypeID: ptID("region"),
		ccID,
		bareName: (countryID, alias) => bareAdminName(iso2ByCountryID.get(countryID) ?? "", alias),
	})

	progress(
		"aliases",
		`${nAlias.toLocaleString()} aliases; ${nBare.toLocaleString()} bare admin aliases; ` +
			`${nMarkFree.toLocaleString()} mark-free aliases` +
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

	const { nicknames, twins } = await refuseNicknamesAndTwins(src, kdb, attrs, progress)

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
		const staged = stageExtractRows({
			out: kdb,
			extractPath: pcDB,
			extractPlacetype: POSTCODE_PLACETYPE,
			ccID,
			ptID,
			stageRow,
			progress,
		})

		nPostcode += staged.primaries
		nPostcodeAlias += staged.aliases
	}

	if (nPostcode > 0) {
		progress("postcodes", `${nPostcode.toLocaleString()} postcodes; ${nPostcodeAlias.toLocaleString()} aliases`)
	}

	let nLocality = 0
	let nLocalityScoped = 0
	let nLocalityAncestor = 0

	for (const locDB of opts.localities ?? []) {
		const staged = stageExtractRows({
			out: kdb,
			extractPath: locDB,
			extractPlacetype: "locality",
			ccID,
			ptID,
			stageRow,
			attrs,
			progress,
		})

		nLocality += staged.primaries
		nLocalityScoped += staged.scoped
		nLocalityAncestor += staged.ancestorRows
	}

	if (nLocality > 0) {
		progress(
			"localities",
			`${nLocality.toLocaleString()} extract localities added` +
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

	for (const fold of opts.keyFolds ?? []) {
		const { rekeyed, merged } = await applyCandidateKeyFold(kdb, fold)

		progress("key-fold", `${fold}: ${rekeyed.toLocaleString()} rows rekeyed, ${merged.toLocaleString()} merged`)
	}

	progress("fts", "building FTS5-trigram fuzzy index")
	createCandidateFTS(kdb)

	const postcodePlacetypeID = ptcodes.get(POSTCODE_PLACETYPE)

	if (postcodePlacetypeID != null) {
		progress("postcode-index", `indexing postcode places by spr_id (placetype id ${postcodePlacetypeID})`)
		await createCandidatePostcodePlaceIndex(kdb, postcodePlacetypeID)
	}

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
		markFreeAliases: nMarkFree,
		regionOfficialRefused,
		nicknameRefused: nicknames.rows,
		abbrevs: nAbbr,
		postcodes: nPostcode,
		postcodeAliases: nPostcodeAlias,
		ancestorRows: sidecar.ancestorRows + nLocalityAncestor,
		ancestorPlaces: sidecar.ancestorPlaces + nLocalityScoped,
		intervalPlaces: sidecar.intervalPlaces,
		...roles,
		importanceScored: importance ? importance.matched : null,
		importanceFiltered: importance ? importance.refused : null,
		populationEstimated: typeof importance?.stats.estimates === "number" ? importance.estimated : null,
		overtureMatches: twins ? twins.matches : null,
		overtureTwinRowsDropped: twins ? twins.rowsDropped : null,
	}
}
