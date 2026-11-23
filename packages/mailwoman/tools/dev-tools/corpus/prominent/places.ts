// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The prominent-places census: which places count as prominent in each country,
 *   the count of a corpus's train rows that write them in the ordinary query shapes,
 *   and how a geocoder answers those shapes.
 *
 *   Prominence is a rank within one country and one placetype band, never a global cutoff,
 *   so a large country can't take every slot and a small one keeps its capital and largest towns.
 *   A place's score is its candidate-table `importance`, else the referential score
 *   of its WOF population, else the referential score of the population of a GeoNames
 *   feature of the same folded name within {@linkcode GEONAMES_MATCH_KM}.
 *
 *   A place with none of the three is unscored, and the census counts it rather than ranking it.
 *
 *   The corpus scan reads every train row through {@linkcode stageTrainRows},
 *   keeps the rows whose spans are one to three admin components, and counts them
 *   by country, source, ordered shape and folded span surfaces.
 *   Every surface is folded by {@linkcode foldSurfaceSQL}, the fold the support index uses,
 *   and every place name is folded by the same SQL before the join.
 */

import { sha256File } from "@mailwoman/core/crypto/hash"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import {
	REFERENTIAL_LOG2_SCALE,
	REFERENTIAL_POPULATION_DIVISOR,
	referentialFromPopulation,
} from "@mailwoman/core/resolver"
import { recordIDSQL } from "@mailwoman/corpus/adapters/record-id"
import { type DisposableDuckDB, type DuckDBLimits, escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { parquetColumnNames } from "@mailwoman/corpus/parquet/readers"
import { PLACE_BANDS, type PlaceBand } from "@mailwoman/corpus/recipes/prominent/places"
import type { CorpusDeletion } from "@mailwoman/corpus/tools/overlay/deletions"
import { baseManifestFiles, localManifestFilePath } from "@mailwoman/corpus/tools/overlay/manifest"
import { foldSurfaceSQL, stageTrainRows, type TrainManifestFile } from "@mailwoman/corpus/tools/support-index"
import { isPostalLocalityPair, readPostalPoints } from "@mailwoman/gazetteer/tools/pipeline/pair/postal-children"
import { normalizeFSTToken } from "@mailwoman/neural/prior/fst"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate/schema"
import { openBuiltClient } from "@mailwoman/sqlite/sealed"
import { resolvePath } from "path-ts"

import {
	PROMINENT_PLACES_RECORD,
	PROMINENT_PLACES_RECORD_VERSION,
	type ProminentPlacesRecord,
} from "#tools/training/audits/prominent/coverage"

// #region Prominence

/**
 * The fewest places one country and band selects, when it ranks at least this number.
 *
 * A country and band with `n` ranked places selects `min(n, clamp(ceil(sqrt(n)), minimum, maximum))`.
 * The square root grows the set with the country's size, and the largest gazetteers still
 * take a few dozen slots where a proportional share would give them thousands.
 *
 * The bounds are registered choices for #3156, open to the operator's decision there.
 */
export const PROMINENT_MINIMUM = 5

/**
 * The most places one country and band selects.
 * See {@linkcode PROMINENT_MINIMUM}.
 */
export const PROMINENT_MAXIMUM = 100

/**
 * The largest difference the SQL referential score may show against {@linkcode referentialFromPopulation}.
 *
 * Both compute the same double-precision expression, so any larger difference is a drift between the two.
 */
const REFERENTIAL_SQL_TOLERANCE = 1e-9

/**
 * The radius a GeoNames feature must lie within to lend its population to an unscored WOF place.
 */
export const GEONAMES_MATCH_KM = 15

/**
 * The radius within which a locality and a localadmin of one name
 * (Zürich, WOF 101748463 and 1394254167) are one place and take one rank.
 */
export const TWIN_KM = 10

/**
 * The radius a capital point must lie within to mark a place as its country's capital.
 */
export const CAPITAL_MATCH_KM = 15

const SQL_HAVERSINE_KM = (aLat: string, aLon: string, bLat: string, bLon: string) =>
	`(2 * 6371.0088 * asin(sqrt(pow(sin(radians(${bLat} - ${aLat}) / 2), 2) + ` +
	`cos(radians(${aLat})) * cos(radians(${bLat})) * pow(sin(radians(${bLon} - ${aLon}) / 2), 2))))`

/**
 * Whether a WOF ancestor's folded name and a GeoNames division's folded ASCII name name one division.
 *
 * Accents are stripped, since GeoNames' ASCII column drops them (`Hải Dương`, `Hai Duong`), and either
 * name may hold the other whole, since one source prefixes the division's kind (`Tinh Hai Duong`).
 * A name under four characters must match exactly, so `Ibb` holds no other name.
 */
const PARENT_NAMES_AGREE_SQL = (wof: string, geonames: string) => {
	const a = `strip_accents(${wof})`
	const b = `strip_accents(${geonames})`

	return `(${a} = ${b} OR (length(${a}) >= 4 AND length(${b}) >= 4 AND (contains(${a}, ${b}) OR contains(${b}, ${a}))))`
}

function quoted(value: string): string {
	return `'${escapeSQLString(value)}'`
}

export interface ProminentPlacesOptions {
	candidateDB: string
	/**
	 * GeoNames country dumps, a DuckDB glob such as `/data/geonames/[A-Z][A-Z].txt`.
	 */
	geonamesGlob: string
	/**
	 * The GeoNames postal export, `allCountries-postal.txt`.
	 */
	geonamesPostal: string
	/**
	 * GeoNames' first-level divisions, `admin1CodesASCII.txt`.
	 * They hold a fallback match's administrative parent.
	 */
	geonamesAdmin1: string
	/**
	 * The directory of GeoNames' per-country postal exports, `<CC>.txt` or `<CC>.zip`,
	 * the files the postal-children location test of #3165 and the pair-index build read.
	 *
	 * The full GB export locates a postcode at its unit, where `allCountries-postal.txt`
	 * holds GB's outward codes only.
	 */
	geonamesPostalDirectory: string
	out: string
	limits?: DuckDBLimits
	log?: (line: string) => void
}

/**
 * Reads every primary place of the two bands from a candidate database into the DuckDB table `wof`.
 */
async function loadCandidatePlaces(db: DisposableDuckDB, candidateDB: string, log: (line: string) => void) {
	await db.run(
		"CREATE TABLE wof (spr_id BIGINT, country VARCHAR, band VARCHAR, placetype VARCHAR, name VARCHAR, " +
			"lat DOUBLE, lon DOUBLE, min_lat DOUBLE, min_lon DOUBLE, max_lat DOUBLE, max_lon DOUBLE, " +
			"population BIGINT, importance DOUBLE, region_id BIGINT, parent_locality VARCHAR)"
	)

	await db.run("CREATE TABLE regions (spr_id BIGINT, country VARCHAR, name VARCHAR, abbrs VARCHAR)")

	using candidates = await openBuiltClient<CandidateDatabase>(candidateDB)

	const placetypes = new Map(
		(await candidates.selectFrom("placetype_codes").select(["id", "placetype"]).execute()).map((row) => [
			row.placetype,
			row.id,
		])
	)

	const placetypeNames = new Map([...placetypes].map(([name, id]) => [id, name]))

	const idOf = (placetype: string) => {
		const id = placetypes.get(placetype)

		if (id == null) throw new Error(`${candidateDB} lists no placetype ${placetype}`)

		return id
	}

	const bandOf = new Map<number, PlaceBand>()

	for (const [band, members] of Object.entries(PLACE_BANDS) as Array<[PlaceBand, readonly string[]]>) {
		for (const member of members) {
			bandOf.set(idOf(member), band)
		}
	}

	const localityID = idOf("locality")
	const regionID = idOf("region")

	const countryCodes = new Map(
		(await candidates.selectFrom("country_codes").select(["id", "code"]).execute()).map((row) => [row.id, row.code])
	)

	// The candidate table's key leads with the name, so a country or placetype filter scans it whole.
	// Each table is therefore streamed once rather than queried per country.
	const parents = new Map<number, { depth: number; name: string }>()

	for await (const ancestor of candidates
		.selectFrom("candidate_ancestor")
		.select(["spr_id", "depth", "parent_name"])
		.where("parent_placetype_id", "=", localityID)
		.stream()) {
		const held = parents.get(ancestor.spr_id)

		if (!held || ancestor.depth < held.depth) {
			parents.set(ancestor.spr_id, { depth: ancestor.depth, name: ancestor.parent_name })
		}
	}

	log(`[prominent] ${parents.size} places with a locality ancestor`)

	const appender = await db.createAppender("wof")
	let placeCount = 0

	for await (const place of candidates
		.selectFrom("candidate")
		.select([
			"spr_id",
			"country_id",
			"placetype_id",
			"name",
			"latitude",
			"longitude",
			"min_lat",
			"min_lon",
			"max_lat",
			"max_lon",
			"population",
			"importance",
			"region_id",
		])
		.where("is_primary", "=", 1)
		.where("placetype_id", "in", [...bandOf.keys()])
		.stream()) {
		const optionalDouble = (value: number | null) =>
			value == null ? appender.appendNull() : appender.appendDouble(value)

		appender.appendBigInt(BigInt(place.spr_id))
		appender.appendVarchar(countryCodes.get(place.country_id) ?? "")
		appender.appendVarchar(bandOf.get(place.placetype_id)!)
		appender.appendVarchar(placetypeNames.get(place.placetype_id)!)
		appender.appendVarchar(place.name ?? "")
		optionalDouble(place.latitude)
		optionalDouble(place.longitude)
		optionalDouble(place.min_lat)
		optionalDouble(place.min_lon)
		optionalDouble(place.max_lat)
		optionalDouble(place.max_lon)

		if (place.population == null) {
			appender.appendNull()
		} else {
			appender.appendBigInt(BigInt(Math.round(place.population)))
		}

		optionalDouble(place.importance)
		appender.appendBigInt(BigInt(place.region_id))

		const parent = place.placetype_id === localityID ? undefined : parents.get(place.spr_id)

		if (parent) {
			appender.appendVarchar(parent.name)
		} else {
			appender.appendNull()
		}

		appender.endRow()

		placeCount++
	}

	appender.closeSync()
	log(`[prominent] ${placeCount} primary places`)

	const regions = new Map<number, { country: string; name: string; abbrs: Set<string> }>()

	for await (const row of candidates
		.selectFrom("candidate")
		.select(["spr_id", "country_id", "name", "name_key", "is_primary", "name_role"])
		.where("placetype_id", "=", regionID)
		.where((eb) => eb.or([eb("is_primary", "=", 1), eb("name_role", "=", "abbr")]))
		.stream()) {
		const region = regions.get(row.spr_id) ?? {
			country: countryCodes.get(row.country_id) ?? "",
			name: "",
			abbrs: new Set<string>(),
		}

		if (row.is_primary === 1) {
			region.name = row.name ?? row.name_key
		}
		// A WOF abbreviation row also holds long forms (`new york state`) and short native names
		// (`東京都`), so only a key of one to three Latin letters or digits reads as the abbreviation.
		// The row's `name` is the region's display name, so the key is the abbreviation's text.
		else if (/^[a-z0-9]{1,3}$/u.test(row.name_key)) {
			region.abbrs.add(row.name_key.toUpperCase())
		}

		regions.set(row.spr_id, region)
	}

	const regionAppender = await db.createAppender("regions")

	for (const [id, region] of regions) {
		if (!region.name) continue

		regionAppender.appendBigInt(BigInt(id))
		regionAppender.appendVarchar(region.country)
		regionAppender.appendVarchar(region.name)
		// The appender takes no untyped list, so the abbreviations travel joined by the unit separator.
		regionAppender.appendVarchar([...region.abbrs].toSorted().join("\u001F"))
		regionAppender.endRow()
	}

	regionAppender.closeSync()
	log(`[prominent] ${regions.size} regions`)

	const capitals = await candidates
		.selectFrom("capital")
		.select(["country", "latitude", "longitude", "level", "keys"])
		.execute()

	await db.run("CREATE TABLE capitals (country VARCHAR, lat DOUBLE, lon DOUBLE, level VARCHAR, keys VARCHAR)")

	const capitalAppender = await db.createAppender("capitals")

	for (const capital of capitals) {
		capitalAppender.appendVarchar(capital.country)
		capitalAppender.appendDouble(capital.latitude)
		capitalAppender.appendDouble(capital.longitude)
		capitalAppender.appendVarchar(capital.level)
		capitalAppender.appendVarchar(capital.keys)
		capitalAppender.endRow()
	}

	capitalAppender.closeSync()
}

/**
 * Writes `match_ancestors (spr_id, fold)`: the folded names of every WOF ancestor
 * of each place in `geonames_match`.
 *
 * The GeoNames parent check compares them against the feature's first-level division.
 *
 * The candidate table's ancestor rows are streamed once and kept only for the matched places.
 */
async function loadMatchAncestors(db: DisposableDuckDB, candidateDB: string): Promise<void> {
	const matched = new Set(
		(await db.runAndReadAll("SELECT spr_id FROM geonames_match"))
			.getRowObjectsJson()
			.map((row) => Number(row["spr_id"]))
	)

	await db.run("CREATE TABLE match_ancestor_names (spr_id BIGINT, name VARCHAR)")

	using candidates = await openBuiltClient<CandidateDatabase>(candidateDB)

	const appender = await db.createAppender("match_ancestor_names")

	for await (const ancestor of candidates.selectFrom("candidate_ancestor").select(["spr_id", "parent_name"]).stream()) {
		if (!matched.has(ancestor.spr_id) || !ancestor.parent_name) continue

		appender.appendBigInt(BigInt(ancestor.spr_id))
		appender.appendVarchar(ancestor.parent_name)
		appender.endRow()
	}

	appender.closeSync()

	await db.run(
		`CREATE TABLE match_ancestors AS SELECT DISTINCT spr_id, ${foldSurfaceSQL("name")} AS fold FROM match_ancestor_names`
	)
}

/**
 * Writes `postal_locality_pairs (spr_id)`: the ranked sub-localities whose pair with their parent
 * locality reads as `locality: child, region: parent` by {@linkcode isPostalLocalityPair},
 * and returns their count with the postal exports read.
 *
 * The postcode points are the country's export in `postalDirectory`, read by
 * {@linkcode readPostalPoints} as the pair-index build reads them, and the regions
 * are the candidate table's first-level WOF regions (`regions`).
 * A country with no export there has no location evidence, so none of its pairs move,
 * and the record lists it.
 */
async function loadPostalLocalityPairs(
	db: DisposableDuckDB,
	postalDirectory: string
): Promise<{ pairs: number; exports: ProminentPlacesRecord["postal_pair_exports"]; without_export: string[] }> {
	const pairs = (
		await db.runAndReadAll(
			"SELECT spr_id, country, name, parent_locality, lat, lon FROM ranked WHERE band = 'sublocality' " +
				"AND rank IS NOT NULL AND parent_locality IS NOT NULL AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY country"
		)
	).getRowObjectsJson()

	const regionNames = new Map<string, Set<string>>()

	for (const row of (await db.runAndReadAll("SELECT country, name FROM regions")).getRowObjectsJson()) {
		const country = String(row["country"])
		const names = regionNames.get(country) ?? new Set<string>()

		names.add(normalizeFSTToken(String(row["name"])))
		regionNames.set(country, names)
	}

	await db.run("CREATE TABLE postal_locality_pairs (spr_id BIGINT)")

	const appender = await db.createAppender("postal_locality_pairs")
	const exports: ProminentPlacesRecord["postal_pair_exports"] = []
	const withoutExport: string[] = []
	let count = 0

	for (const [country, rows] of Map.groupBy(pairs, (row) => String(row["country"]))) {
		const regions = regionNames.get(country)

		// A country whose regions share no parent's name moves no pair, and its postcodes needn't be read.
		if (!regions || !rows.some((row) => regions.has(normalizeFSTToken(String(row["parent_locality"]))))) continue

		const hasExport =
			(await pathExists(resolvePath(postalDirectory, `${country}.txt`))) ||
			(await pathExists(resolvePath(postalDirectory, `${country}.zip`)))

		if (!hasExport) {
			withoutExport.push(country)

			continue
		}

		const postal = await readPostalPoints(postalDirectory, country)

		exports.push({ country, artifact: postal.artifact, sha256: await sha256File(postal.artifact) })

		for (const row of rows) {
			const pair = {
				child: normalizeFSTToken(String(row["name"])),
				parent: normalizeFSTToken(String(row["parent_locality"])),
			}

			if (isPostalLocalityPair(postal, [{ lat: Number(row["lat"]), lon: Number(row["lon"]) }], pair, regions)) {
				appender.appendBigInt(BigInt(Number(row["spr_id"])))
				appender.endRow()

				count++
			}
		}
	}

	appender.closeSync()

	return { pairs: count, exports, without_export: withoutExport }
}

/**
 * The SQL expression of {@linkcode referentialFromPopulation}, with a population of zero or none
 * read as no score. {@linkcode buildProminentPlaces} checks it against the function before use.
 */
function referentialSQL(population: string): string {
	return (
		`CASE WHEN coalesce(${population}, 0) <= 0 THEN NULL ELSE ` +
		`least(1, log2(1 + ${population} / ${REFERENTIAL_POPULATION_DIVISOR}) / ${REFERENTIAL_LOG2_SCALE}) END`
	)
}

/**
 * Writes `places.parquet`: every primary place of the two bands with its score,
 * its score's source, its rank and decile within its country and band, whether it is prominent
 * and whether it is a capital, its parent locality, region and region abbreviations, and
 * whether GeoNames' postal export lists its name as a postcode place name in its country,
 * and, for a sub-locality, whether its pair with its parent locality reads as a locality
 * and its region (`postal_pair`, {@linkcode isPostalLocalityPair}).
 */
export async function buildProminentPlaces(options: ProminentPlacesOptions): Promise<void> {
	const log = options.log ?? (() => {})

	using db = await openDuckDB(options.limits)

	await loadCandidatePlaces(db, options.candidateDB, log)

	for (const population of [1, 5000, 250_000, 8_000_000, 900_000_000]) {
		const row = (
			await db.runAndReadAll(`SELECT ${referentialSQL(String(population))} AS v`)
		).getRowObjectsJson()[0] as {
			v: number
		}

		if (Math.abs(Number(row.v) - referentialFromPopulation(population)) > REFERENTIAL_SQL_TOLERANCE) {
			throw new Error(`the SQL referential score of ${population} differs from referentialFromPopulation`)
		}
	}

	log("[prominent] reading GeoNames populated features")

	await db.run(
		`CREATE TABLE geonames AS SELECT column00 AS geonameid, column08 AS country, column10 AS admin1, ` +
			`${foldSurfaceSQL("column01")} AS fold, ` +
			`${foldSurfaceSQL("column02")} AS ascii_fold, column04::DOUBLE AS lat, column05::DOUBLE AS lon, ` +
			`TRY_CAST(column14 AS BIGINT) AS population FROM read_csv(${quoted(options.geonamesGlob)}, ` +
			`delim = '\t', quote = '', escape = '', header = false, all_varchar = true, null_padding = true) ` +
			`WHERE column06 IN ('P', 'A') AND TRY_CAST(column14 AS BIGINT) > 0`
	)

	// `admin1CodesASCII.txt` keys each first-level division as `<country>.<admin1 code>`.
	await db.run(
		`CREATE TABLE admin1 AS SELECT column0 AS key, ${foldSurfaceSQL("column1")} AS fold, ` +
			`${foldSurfaceSQL("column2")} AS ascii_fold FROM read_csv(${quoted(options.geonamesAdmin1)}, ` +
			`delim = '\t', quote = '', escape = '', header = false, all_varchar = true, null_padding = true)`
	)

	await db.run(
		`CREATE TABLE postal AS SELECT column00 AS country, ${foldSurfaceSQL("column02")} AS fold, ` +
			"TRY_CAST(column09 AS DOUBLE) AS lat, TRY_CAST(column10 AS DOUBLE) AS lon " +
			`FROM read_csv(${quoted(options.geonamesPostal)}, delim = '\t', quote = '', escape = '', header = false, ` +
			`all_varchar = true, null_padding = true) WHERE column02 IS NOT NULL`
	)

	await db.run("CREATE TABLE postal_names AS SELECT DISTINCT country, fold FROM postal")

	log("[prominent] scoring and ranking")

	// WOF writes `??` for a place without a country, and a rank needs a country to rank within.
	await db.run(
		`CREATE TABLE folded AS SELECT *, ${foldSurfaceSQL("name")} AS fold FROM wof ` +
			"WHERE name <> '' AND regexp_matches(country, '^[A-Z]{2}$')"
	)

	// The candidate GeoNames feature is the most populous one of the place's folded name within the radius.
	await db.run(
		"CREATE TABLE geonames_candidates AS SELECT w.spr_id, g.geonameid, g.country, g.admin1, g.lat, g.lon, g.population, " +
			`${SQL_HAVERSINE_KM("w.lat", "w.lon", "g.lat", "g.lon")} AS km FROM folded w ` +
			"JOIN geonames g ON g.country = w.country AND (g.fold = w.fold OR g.ascii_fold = w.fold) " +
			"WHERE w.importance IS NULL AND coalesce(w.population, 0) <= 0 AND w.lat IS NOT NULL AND " +
			`${SQL_HAVERSINE_KM("w.lat", "w.lon", "g.lat", "g.lon")} <= ${GEONAMES_MATCH_KM}`
	)

	await db.run(
		"CREATE TABLE geonames_match AS SELECT spr_id, arg_max(geonameid, population) AS geonameid, " +
			"max(population) AS population, arg_max(km, population) AS km, arg_max(admin1, population) AS admin1, " +
			"arg_max(lat, population) AS lat, arg_max(lon, population) AS lon, arg_max(country, population) AS country " +
			"FROM geonames_candidates GROUP BY spr_id"
	)

	await loadMatchAncestors(db, options.candidateDB)

	// The #3156 decision checks a match before it decides a required row: its country
	// (the join requires it), its administrative parent where both sources record one,
	// and the competing same-name candidates.
	//
	// GeoNames' first-level division and WOF's region can sit at different levels
	// (England against Greater London).
	// The parent agrees when the GeoNames division matches any of the place's WOF ancestors.
	// A competitor is another primary WOF place of the same band and folded name
	// within the radius of the GeoNames feature.
	// It could claim the population as well.
	// A record of another band with the name, such as a borough's own district record,
	// describes the same area.
	await db.run(
		"CREATE TABLE geonames_check AS SELECT m.spr_id, " +
			"CASE WHEN EXISTS (SELECT 1 FROM folded o WHERE o.country = m.country AND o.band = w.band AND o.fold = w.fold " +
			`AND o.spr_id <> m.spr_id AND o.lat IS NOT NULL AND ${SQL_HAVERSINE_KM("o.lat", "o.lon", "m.lat", "m.lon")} <= ${GEONAMES_MATCH_KM} ` +
			// A same-name record within the twin radius is the place's own twin. The two take one rank.
			`AND ${SQL_HAVERSINE_KM("o.lat", "o.lon", "w.lat", "w.lon")} > ${TWIN_KM}) ` +
			"THEN 'competing-candidate' " +
			"WHEN a.key IS NOT NULL AND EXISTS (SELECT 1 FROM match_ancestors x WHERE x.spr_id = m.spr_id) AND NOT EXISTS (" +
			`SELECT 1 FROM match_ancestors x WHERE x.spr_id = m.spr_id AND (${PARENT_NAMES_AGREE_SQL("x.fold", "a.fold")} OR ${PARENT_NAMES_AGREE_SQL("x.fold", "a.ascii_fold")})) ` +
			"THEN 'admin-parent-mismatch' ELSE 'verified' END AS geonames_check " +
			"FROM geonames_match m JOIN folded w ON w.spr_id = m.spr_id " +
			"LEFT JOIN admin1 a ON a.key = m.country || '.' || m.admin1"
	)

	await db.run(
		"CREATE TABLE scored AS SELECT w.*, " +
			`coalesce(w.importance, ${referentialSQL("w.population")}, ${referentialSQL("m.population")}) AS score, ` +
			"CASE WHEN w.importance IS NOT NULL THEN 'importance' WHEN coalesce(w.population, 0) > 0 THEN 'population' " +
			"WHEN m.population IS NOT NULL THEN 'geonames' ELSE 'unscored' END AS score_source, " +
			"coalesce(nullif(w.population, 0), m.population) AS population_used, " +
			"m.geonameid AS geonames_id, m.km AS geonames_km, c.geonames_check " +
			"FROM folded w LEFT JOIN geonames_match m ON m.spr_id = w.spr_id LEFT JOIN geonames_check c ON c.spr_id = w.spr_id"
	)

	// A locality and its localadmin can share a name and a centroid (Zürich, WOF 101748463 and 1394254167).
	// The lower-scored twin within TWIN_KM is dropped, so one place takes one rank.
	await db.run(
		"CREATE TABLE twins AS SELECT DISTINCT b.spr_id FROM scored a JOIN scored b ON a.country = b.country " +
			"AND a.band = b.band AND a.fold = b.fold AND a.spr_id <> b.spr_id AND a.score IS NOT NULL AND b.score IS NOT NULL " +
			"AND (a.score > b.score OR (a.score = b.score AND a.spr_id < b.spr_id)) AND " +
			`${SQL_HAVERSINE_KM("a.lat", "a.lon", "b.lat", "b.lon")} <= ${TWIN_KM}`
	)

	await db.run(
		"CREATE TABLE ranked AS SELECT s.*, " +
			"CASE WHEN s.score IS NULL THEN NULL ELSE row_number() OVER (PARTITION BY s.country, s.band, s.score IS NULL " +
			"ORDER BY s.score DESC, s.population_used DESC NULLS LAST, s.spr_id) END AS rank, " +
			"count(s.score) OVER (PARTITION BY s.country, s.band) AS scored_in_band, " +
			"count(*) OVER (PARTITION BY s.country, s.band) AS places_in_band " +
			"FROM scored s WHERE s.spr_id NOT IN (SELECT spr_id FROM twins)"
	)

	await db.run(
		"CREATE TABLE capital_keys AS SELECT country, lat, lon, unnest(from_json(keys, '[\"VARCHAR\"]')) AS key " +
			"FROM capitals WHERE level = 'national'"
	)

	log("[prominent] reading sub-locality pairs by the postal-locality rule")

	const postalPairs = await loadPostalLocalityPairs(db, options.geonamesPostalDirectory)

	log(
		`[prominent] ${postalPairs.pairs} sub-locality pairs read as a locality and its region; ` +
			`${postalPairs.exports.length} postal exports read, none for ${postalPairs.without_export.join(", ") || "no country"}`
	)

	await db.run(
		`COPY (SELECT r.spr_id, r.country, r.band, r.placetype, r.name, r.fold, r.lat, r.lon, r.min_lat, r.min_lon, ` +
			"r.max_lat, r.max_lon, r.score, r.score_source, r.population_used, r.rank, r.scored_in_band, r.places_in_band, " +
			"CASE WHEN r.rank IS NULL THEN NULL ELSE ceil(10.0 * r.rank / r.scored_in_band)::INTEGER END AS decile, " +
			`CASE WHEN r.rank IS NULL THEN false ELSE r.rank <= least(r.scored_in_band, greatest(${PROMINENT_MINIMUM}, ` +
			`least(${PROMINENT_MAXIMUM}, ceil(sqrt(r.scored_in_band))))) END AS by_rank, ` +
			"EXISTS (SELECT 1 FROM capital_keys c WHERE c.country = r.country AND c.key = r.fold AND " +
			` ${SQL_HAVERSINE_KM("r.lat", "r.lon", "c.lat", "c.lon")} <= ${CAPITAL_MATCH_KM}) AS capital, ` +
			"r.parent_locality, g.name AS region, " +
			"CASE WHEN g.abbrs = '' THEN []::VARCHAR[] ELSE string_split(g.abbrs, chr(31)) END AS region_abbrs, " +
			"EXISTS (SELECT 1 FROM postal_names p WHERE p.country = r.country AND p.fold = r.fold) AS postal_name, " +
			// A postal record inside the place's bounding box speaks for the place.
			// A postal record of the name elsewhere in the country speaks only for the name.
			"CASE WHEN EXISTS (SELECT 1 FROM postal p WHERE p.country = r.country AND p.fold = r.fold AND " +
			"p.lat BETWEEN r.min_lat AND r.max_lat AND p.lon BETWEEN r.min_lon AND r.max_lon) THEN 'place' " +
			"WHEN EXISTS (SELECT 1 FROM postal_names p WHERE p.country = r.country AND p.fold = r.fold) THEN 'name' " +
			"ELSE 'none' END AS postal_evidence, r.geonames_id, r.geonames_km, r.geonames_check, " +
			"r.spr_id IN (SELECT spr_id FROM postal_locality_pairs) AS postal_pair " +
			`FROM ranked r LEFT JOIN regions g ON g.spr_id = r.region_id) TO ${quoted(`${options.out}/places.parquet`)} (FORMAT PARQUET)`
	)

	log(`[prominent] wrote ${options.out}/places.parquet`)

	const counts = (
		await db.runAndReadAll(
			`SELECT band, score_source, count(*)::INTEGER AS places, count(*) FILTER (WHERE by_rank)::INTEGER AS selected, ` +
				"count(*) FILTER (WHERE geonames_check = 'verified')::INTEGER AS geonames_verified " +
				`FROM read_parquet(${quoted(`${options.out}/places.parquet`)}) GROUP BY ALL ORDER BY band, score_source`
		)
	)
		.getRowObjectsJson()
		.map((row) => ({
			band: String(row["band"]),
			score_source: String(row["score_source"]),
			places: Number(row["places"]),
			selected: Number(row["selected"]),
			geonames_verified: Number(row["geonames_verified"]),
		}))

	log("[prominent] hashing the inputs")

	const record: ProminentPlacesRecord = {
		version: PROMINENT_PLACES_RECORD_VERSION,
		written_at: new Date().toISOString(),
		candidate_db: options.candidateDB,
		candidate_db_sha256: await sha256File(options.candidateDB),
		geonames_postal: options.geonamesPostal,
		geonames_postal_sha256: await sha256File(options.geonamesPostal),
		geonames_admin1: options.geonamesAdmin1,
		geonames_admin1_sha256: await sha256File(options.geonamesAdmin1),
		geonames_glob: options.geonamesGlob,
		geonames_postal_directory: options.geonamesPostalDirectory,
		postal_pair_exports: postalPairs.exports,
		postal_pair_countries_without_export: postalPairs.without_export,
		postal_pairs: postalPairs.pairs,
		places_sha256: await sha256File(`${options.out}/places.parquet`),
		rule: {
			selection: `min(n, clamp(ceil(sqrt(n)), ${PROMINENT_MINIMUM}, ${PROMINENT_MAXIMUM})) per country and band, plus the national capital`,
			geonames_match_km: GEONAMES_MATCH_KM,
			capital_match_km: CAPITAL_MATCH_KM,
		},
		counts,
	}

	await writeLocalJSONFile(record, `${options.out}/${PROMINENT_PLACES_RECORD}`)
}

// #endregion

// #region Corpus scan

/**
 * The component tags a short admin row may hold.
 * A row with any other tag is a fuller address.
 */
export const SHORT_ADMIN_TAGS = [
	"locality",
	"dependent_locality",
	"region",
	"subregion",
	"country",
	"municipality",
	"district",
	"prefecture",
] as const

/**
 * The longest short admin row, in spans.
 */
export const SHORT_ADMIN_MAX_SPANS = 3

export interface ShortAdminScanOptions {
	manifest: string
	out: string
	/**
	 * Keeps each row's group as column `g` (`recordIDOf(base_source_id ?? source_id)`),
	 * for a reader that needs which groups write a surface.
	 */
	groups?: boolean
	limitFiles?: number
	limits?: DuckDBLimits
	log?: (line: string) => void
}

export interface ShortAdminScanRecord {
	manifest: string
	corpus_version: string | null
	taken_at: string
	elapsed_ms: number
	files_listed: number
	files_read: number
	files_held_out: number
	short_admin_train_rows: number
}

/**
 * Writes `short-admin-rows.parquet`: the train rows whose spans are one to
 * {@linkcode SHORT_ADMIN_MAX_SPANS} of {@linkcode SHORT_ADMIN_TAGS}, counted by country,
 * source, ordered shape and the folded surface of each span.
 */
export async function scanShortAdminRows(options: ShortAdminScanOptions): Promise<ShortAdminScanRecord> {
	const startedAt = Date.now()
	const { readLocalJSONFile } = await import("@mailwoman/core/fs/readers")

	const manifest = await readLocalJSONFile<{ corpus_version?: string; deletions?: CorpusDeletion[] }>(options.manifest)

	const files = baseManifestFiles<TrainManifestFile>(manifest)

	using db = await openDuckDB(options.limits)

	await db.run("CREATE TEMP TABLE excluded_ids (id VARCHAR)")

	const keys = options.groups ? "country, source, shape, s1, s2, s3, g" : "country, source, shape, s1, s2, s3"

	await db.run(
		"CREATE TEMP TABLE agg (country VARCHAR, source VARCHAR, shape VARCHAR, s1 VARCHAR, s2 VARCHAR, s3 VARCHAR, " +
			`${options.groups ? "g VARCHAR, " : ""}n BIGINT)`
	)

	const tagList = SHORT_ADMIN_TAGS.map(quoted).join(", ")
	const surface = (i: number) => `substr(raw, span_starts[${i}] + 1, span_ends[${i}] - span_starts[${i}])`

	const surfaces =
		"country, source, array_to_string(span_tags, '|') AS shape, " +
		[1, 2, 3].map((i) => `CASE WHEN len(span_tags) >= ${i} THEN ${foldSurfaceSQL(surface(i))} END AS s${i}`).join(", ")

	// A row's group is its `base_source_id`, else its own `source_id`, each read up to the last `#`.
	const groupColumn = async (file: TrainManifestFile) => {
		const columns = await parquetColumnNames(localManifestFilePath(file.path))
		const base = columns.includes("base_source_id") ? "CAST(base_source_id AS VARCHAR)" : "CAST(NULL AS VARCHAR)"

		return `, ${recordIDSQL(`coalesce(${base}, CAST(source_id AS VARCHAR))`)} AS g`
	}

	const rowFilter = `len(span_tags) BETWEEN 1 AND ${SHORT_ADMIN_MAX_SPANS} AND list_has_all([${tagList}], span_tags)`

	let filesRead = 0
	let filesHeldOut = 0
	let rows = 0

	for (const [index, file] of files.entries()) {
		if (options.limitFiles && filesRead >= options.limitFiles) break

		const staged = await stageTrainRows(
			db,
			options.manifest,
			file,
			manifest.deletions ?? [],
			surfaces + (options.groups && file.split !== "val" && file.split !== "test" ? await groupColumn(file) : ""),
			options.limits,
			rowFilter
		)

		if (staged === null) {
			filesHeldOut++

			continue
		}

		filesRead++
		rows += staged

		if (staged) {
			await db.run(`INSERT INTO agg SELECT ${keys}, count(*) FROM r GROUP BY ALL`)
		}

		if (filesRead % 50 === 0) {
			await db.run(`CREATE TEMP TABLE agg_merged AS SELECT ${keys}, sum(n)::BIGINT AS n FROM agg GROUP BY ALL`)

			await db.run("DROP TABLE agg")
			await db.run("ALTER TABLE agg_merged RENAME TO agg")
		}

		options.log?.(
			`[prominent] ${index + 1}/${files.length} ${file.source ?? file.path}: ${staged} short admin rows, ` +
				`${Math.round((Date.now() - startedAt) / 1000)}s elapsed`
		)
	}

	await db.run(
		`COPY (SELECT ${keys}, sum(n)::BIGINT AS rows FROM agg GROUP BY ALL ` +
			`ORDER BY country, shape, s1, s2, s3, source${options.groups ? ", g" : ""}) TO ${quoted(`${options.out}/short-admin-rows.parquet`)} (FORMAT PARQUET)`
	)

	return {
		manifest: options.manifest,
		corpus_version: manifest.corpus_version ?? null,
		taken_at: new Date().toISOString(),
		elapsed_ms: Date.now() - startedAt,
		files_listed: files.length,
		files_read: filesRead,
		files_held_out: filesHeldOut,
		short_admin_train_rows: rows,
	}
}

// #endregion

// #region Coverage

/**
 * Writes `place-shapes.parquet`, one row per place and applicable shape with its
 * train rows and the rows whose place span holds each tag, and `coverage.parquet`,
 * the per country, band, decile and shape aggregate: places, places with a train row,
 * places whose rows write the place under the band's expected tag, and rows.
 *
 * A bare surface is shared by every homonym in the country, so the bare shape
 * credits each of them with the same rows.
 * The region shapes separate homonyms in different regions.
 */
export async function measureCoverage(options: { out: string; limits?: DuckDBLimits }): Promise<void> {
	using db = await openDuckDB(options.limits)

	const places = quoted(`${options.out}/places.parquet`)
	const rows = quoted(`${options.out}/short-admin-rows.parquet`)

	await db.run(`CREATE TABLE p AS SELECT * FROM read_parquet(${places})`)
	await db.run(`CREATE TABLE a AS SELECT *, string_split(shape, '|') AS tags FROM read_parquet(${rows})`)

	await db.run(
		"CREATE TABLE forms AS " +
			"SELECT spr_id, country, 'bare' AS query_shape, NULL::VARCHAR AS second FROM p UNION ALL " +
			`SELECT spr_id, country, 'parent', ${foldSurfaceSQL("parent_locality")} FROM p WHERE parent_locality IS NOT NULL AND band = 'sublocality' UNION ALL ` +
			`SELECT spr_id, country, 'region', ${foldSurfaceSQL("region")} FROM p WHERE region IS NOT NULL UNION ALL ` +
			`SELECT spr_id, country, 'region_abbr', ${foldSurfaceSQL("abbr")} FROM (SELECT spr_id, country, unnest(region_abbrs) AS abbr FROM p) ` +
			"UNION ALL SELECT spr_id, country, 'country', NULL FROM p"
	)

	await db.run(
		"CREATE TABLE hits AS SELECT f.spr_id, f.query_shape, a.tags[1] AS place_tag, sum(a.rows)::BIGINT AS rows " +
			"FROM forms f JOIN p ON p.spr_id = f.spr_id JOIN a ON a.country = f.country AND a.s1 = p.fold AND " +
			"((f.query_shape = 'bare' AND len(a.tags) = 1) OR " +
			"(f.query_shape = 'country' AND len(a.tags) = 2 AND a.tags[2] = 'country') OR " +
			"(f.query_shape IN ('parent', 'region', 'region_abbr') AND len(a.tags) = 2 AND a.s2 = f.second)) " +
			"GROUP BY ALL"
	)

	await db.run(
		`COPY (SELECT p.spr_id, p.country, p.band, p.name, p.decile, p.by_rank, p.capital, p.postal_name, f.query_shape, ` +
			"coalesce(sum(h.rows), 0)::BIGINT AS rows, " +
			"coalesce(sum(h.rows) FILTER (WHERE h.place_tag = 'locality'), 0)::BIGINT AS rows_locality, " +
			"coalesce(sum(h.rows) FILTER (WHERE h.place_tag = 'dependent_locality'), 0)::BIGINT AS rows_dependent_locality, " +
			"coalesce(sum(h.rows) FILTER (WHERE h.place_tag NOT IN ('locality', 'dependent_locality')), 0)::BIGINT AS rows_other_tag " +
			"FROM (SELECT DISTINCT spr_id, query_shape FROM forms) f JOIN p ON p.spr_id = f.spr_id " +
			"LEFT JOIN hits h ON h.spr_id = f.spr_id AND h.query_shape = f.query_shape GROUP BY ALL) " +
			`TO ${quoted(`${options.out}/place-shapes.parquet`)} (FORMAT PARQUET)`
	)

	// The band's expected tag: a locality is written as a locality in every shape.
	// A sub-locality is a dependent locality beside its parent, and either tag elsewhere,
	// since its postal form may make it the locality.
	await db.run(
		`COPY (SELECT country, band, decile, (by_rank OR capital) AS prominent, query_shape, count(*) AS places, ` +
			"count(*) FILTER (WHERE rows > 0) AS covered, " +
			"count(*) FILTER (WHERE CASE WHEN band = 'locality' THEN rows_locality > 0 " +
			"WHEN query_shape = 'parent' THEN rows_dependent_locality > 0 " +
			"ELSE rows_locality + rows_dependent_locality > 0 END) AS covered_expected_tag, " +
			"sum(rows)::BIGINT AS rows FROM read_parquet(" +
			quoted(`${options.out}/place-shapes.parquet`) +
			") GROUP BY ALL) " +
			`TO ${quoted(`${options.out}/coverage.parquet`)} (FORMAT PARQUET)`
	)
}

// #endregion
