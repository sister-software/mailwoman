/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `localities-tw-districts.db` — Taiwan's 鄉鎮市區 (the township / county-administered-city / district tier)
 *   as one locality row each, derived from the civil-affairs address register rather than from WOF.
 *
 *   WHY NOT WOF: the admin artifact carries the tier twice and both copies are wrong for a Han query. A parsed
 *   `新北市林口區` scoped to New Taipei City finds no in-region row keyed `林口區`: the record that carries the Han
 *   names (WOF 102026697) has no parent and a centroid 54 km away in the hills, while the correctly parented record
 *   (WOF 890467835) carries only the Latin `Linkou`. Across the 289 units the training board holds, 102 have no
 *   Han-keyed TW row at all, 15 have one only on a namesake in another 縣市, and 10 only on a parentless row.
 *
 *   SOURCE + LICENSE: the pinned Overture Maps addresses parquet for Taiwan (`overture/<release>/addresses-tw.parquet`,
 *   CDLA-Permissive-2.0), whose rows come from the 15 civil-affairs bureaus' registers under the Open Government Data
 *   License, Taiwan, v1.0 — the same input and the same license expression as the rooftop tier
 *   (`situs address-points --country TW`). `address_levels[1]` is the 縣市 and `address_levels[2]` the 鄉鎮市區,
 *   the register's own administrative pair; there is no free-text grouping here, so no thin-group threshold either —
 *   every pair is a real unit, and the smallest (金門縣烏坵鄉, 3 points) is reported rather than dropped.
 *
 *   SHAPE: one `spr` row per (縣市, 鄉鎮市區), placetype `locality` — the tier `placetypeMapForCountry("tw")` maps a
 *   parsed `subregion` onto — with the MEDIAN address point as the centroid and the p5–p95 envelope as the bbox. The
 *   縣市 is matched to its WOF region by name (the official `zho` name first, then any Han name that names exactly one
 *   region, then the name minus its 縣/市 suffix, which is how 桃園市 reaches a region WOF still names 桃園縣), and the
 *   match is written as an `ancestors` row so the candidate build stamps the row with the region's scope. `names`
 *   carries the register's spelling as the official name and its 臺/台 twin as an alias. Population is 0 (unmeasured:
 *   an address-point count is not a population), so a row wins only where its key is the answer.
 *
 *   Run: mailwoman gazetteer build tw-districts [--release <overture release>] [--parquet <path>] [--admin <path>]
 *   [--out <localities-tw-districts.db>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { OVERTURE_ADDRESSES_RELEASE } from "@mailwoman/core/overture-pins"
import { TW_DISTRICT_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { getRow } from "@mailwoman/core/utils"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { normalizeLocalityForKeyLocale } from "@mailwoman/resolver-wof-sqlite/street"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"
import { resolvePath } from "path-ts"

import { DEFAULT_ADMIN_DB, wofDir } from "#gazetteer-pipeline"

/**
 * The license expression the artifact carries — Overture's theme license AND the register's own, the pair the rooftop
 * tier stamps for the same input.
 */
export const TW_DISTRICTS_LICENSE = "CDLA-Permissive-2.0 AND OGDL-Taiwan-1.0"

/**
 * One Han name a WOF Taiwan region carries, as the admin `names` table has it.
 */
export interface TaiwanRegionName {
	id: number
	name: string
	/**
	 * The `names.official` bit — 1 on the region's own official `zho` name, 0 on every other Han spelling it carries (a
	 * county listed under a city's name, a pre-upgrade name, a script variant).
	 */
	official: boolean
}

/**
 * The 縣市 → WOF region match. Three rungs, each answering only when it names exactly one region:
 *
 * 1. The official `zho` name (`新竹市` → Hsinchu City, never Hsinchu County, which also lists `新竹市` as a variant);
 * 2. Any Han name, when only one region carries it;
 * 3. The name minus its 縣/市 suffix against rung 1 and 2 (`桃園市` → `桃園`, the only name WOF gives the region that became a
 *    special municipality after the record was written).
 *
 * Every comparison runs through the `zh` locality fold, so 臺 and 台 spellings meet. `undefined` is a real absence — a 縣市
 * the admin artifact does not know — and the caller reports it rather than guessing.
 */
export function matchTaiwanRegion(regionName: string, regions: readonly TaiwanRegionName[]): number | undefined {
	const fold = (name: string): string => normalizeLocalityForKeyLocale(name, "zh")
	const wanted = fold(regionName)

	const unique = (candidates: readonly TaiwanRegionName[]): number | undefined => {
		const ids = new Set(candidates.map((r) => r.id))

		return ids.size === 1 ? [...ids][0] : undefined
	}

	const byName = (key: string): number | undefined =>
		unique(regions.filter((r) => r.official && fold(r.name) === key)) ??
		unique(regions.filter((r) => fold(r.name) === key))

	const exact = byName(wanted)

	if (exact !== undefined) return exact

	const stem = wanted.replace(/[縣市]$/u, "")

	return stem !== wanted ? byName(stem) : undefined
}

/**
 * The register's spelling plus its 臺/台 twin, the two forms a person types. A name carrying neither character has no
 * twin and yields itself alone.
 */
export function districtNameVariants(name: string): string[] {
	const twin = name.includes("臺")
		? name.replaceAll("臺", "台")
		: name.includes("台")
			? name.replaceAll("台", "臺")
			: name

	return twin === name ? [name] : [name, twin]
}

/**
 * One (縣市, 鄉鎮市區) group as the parquet aggregation answers it.
 */
export interface TaiwanDistrictGroup {
	region: string
	district: string
	points: number
	lat: number
	lon: number
	minLat: number
	minLon: number
	maxLat: number
	maxLon: number
}

export interface BuildTWDistrictsOptions {
	/**
	 * The Overture release directory under `<data-root>/overture/`. Default {@link OVERTURE_ADDRESSES_RELEASE}.
	 */
	release?: string
	/**
	 * The Taiwan addresses parquet. Default `<data-root>/overture/<release>/addresses-tw.parquet`.
	 */
	parquetPath?: string
	/**
	 * The admin WOF database the 縣市 names are matched against. Default `<data-root>/wof/admin-global-priority.db`.
	 */
	adminPath?: string
	/**
	 * Output database. Default `<data-root>/wof/localities-tw-districts.db`.
	 */
	out?: string
	/**
	 * DuckDB thread cap.
	 */
	threads?: number
}

export interface BuildTWDistrictsResult {
	out: string
	inserted: number
	/**
	 * Rows whose 縣市 matched a WOF region and carry an `ancestors` row; the remainder folded unscoped.
	 */
	scoped: number
	/**
	 * The 縣市 names no WOF region answered to, each with its group count.
	 */
	unmatchedRegions: Array<{ region: string; groups: number }>
	/**
	 * The smallest group kept, so a thin unit is visible in the log rather than silently a row.
	 */
	smallest: { region: string; district: string; points: number } | undefined
	sourceMD5: string
}

/**
 * The Han names every current WOF Taiwan region carries, official bit included.
 */
function readTaiwanRegions(admin: DatabaseClient<WOFDatabase>): TaiwanRegionName[] {
	const rows: TaiwanRegionName[] = []

	for (const r of admin
		.prepare(
			`SELECT n.id AS id, n.name AS name, n.official AS official
			 FROM names n JOIN spr s ON s.id = n.id
			 WHERE s.country = 'TW' AND s.placetype = 'region' AND s.is_current != 0 AND s.is_deprecated = 0
			   AND n.language IN ('zho', 'yue')`
		)
		.iterate()) {
		rows.push({ id: Number(r.id), name: String(r.name), official: Number(r.official) === 1 })
	}

	return rows
}

/**
 * Aggregate the parquet into one group per (縣市, 鄉鎮市區). DuckDB's `quantile_cont` gives the median and the p5/p95
 * envelope in one scan; BigInt counts are narrowed at the boundary.
 */
async function readDistrictGroups(parquetPath: string, threads: number | undefined): Promise<TaiwanDistrictGroup[]> {
	let DuckDBInstance: typeof import("@duckdb/node-api").DuckDBInstance

	try {
		;({ DuckDBInstance } = await import("@duckdb/node-api"))
	} catch {
		throw new Error(
			"@duckdb/node-api is not installed — `gazetteer build tw-districts` is a maintainer-only data command"
		)
	}

	const instance = await DuckDBInstance.create()
	const duck = await instance.connect()

	if (threads) {
		await duck.run(`SET threads TO ${Math.trunc(threads)}`)
	}

	const escaped = parquetPath.replaceAll("'", "''")

	const reader = await duck.runAndReadAll(
		`SELECT address_levels[1].value AS region, address_levels[2].value AS district, count(*) AS points,
			quantile_cont(lat, 0.5) AS lat, quantile_cont(lon, 0.5) AS lon,
			quantile_cont(lat, 0.05) AS min_lat, quantile_cont(lon, 0.05) AS min_lon,
			quantile_cont(lat, 0.95) AS max_lat, quantile_cont(lon, 0.95) AS max_lon
		 FROM read_parquet('${escaped}')
		 WHERE nullif(trim(address_levels[1].value), '') IS NOT NULL AND nullif(trim(address_levels[2].value), '') IS NOT NULL
		   AND lat IS NOT NULL AND lon IS NOT NULL
		 GROUP BY 1, 2 ORDER BY 1, 2`
	)

	return reader.getRowObjects().map((r) => ({
		region: String(r.region).trim(),
		district: String(r.district).trim(),
		points: Number(r.points),
		lat: Number(r.lat),
		lon: Number(r.lon),
		minLat: Number(r.min_lat),
		minLon: Number(r.min_lon),
		maxLat: Number(r.max_lat),
		maxLon: Number(r.max_lon),
	}))
}

/**
 * Build the sealed Taiwan districts database. NOT re-exported from a barrel — the command lazy-imports it
 * (optional-peer discipline, same as the NZ and CZ builders).
 */
export async function buildTWDistrictsDatabase(opts: BuildTWDistrictsOptions = {}): Promise<BuildTWDistrictsResult> {
	const { createUnifiedIndexes, createUnifiedSchema } = await import("@mailwoman/resolver-wof-sqlite/unified-schema")
	const { buildPlaceSearchFTS } = await import("@mailwoman/resolver-wof-sqlite")
	const release = opts.release ?? OVERTURE_ADDRESSES_RELEASE
	const parquetPath = opts.parquetPath ?? String(dataRootPath("overture", release, "addresses-tw.parquet"))
	const adminPath = opts.adminPath ?? resolvePath(wofDir(), DEFAULT_ADMIN_DB)
	const outPath = opts.out ?? String(dataRootPath("wof", "localities-tw-districts.db"))
	const tmpPath = `${outPath}.tmp`

	const sourceMD5 = await md5File(parquetPath)
	const groups = await readDistrictGroups(parquetPath, opts.threads)

	let regions: TaiwanRegionName[]
	let countryID: number | undefined

	{
		using admin = new DatabaseClient<WOFDatabase>(adminPath, { readOnly: true })
		regions = readTaiwanRegions(admin)

		countryID = getRow<{ id: number }>(
			admin.prepare("SELECT id FROM spr WHERE country = 'TW' AND placetype = 'country' AND is_current != 0 LIMIT 1")
		)?.id
	}

	if (!regions.length) {
		throw new Error(
			`${adminPath} carries no Han names for a Taiwan region — the wrong admin database, or a fold that dropped them`
		)
	}

	await removePathIfPresent(tmpPath)

	let inserted = 0
	let scoped = 0
	const unmatched = new Map<string, number>()
	let smallest: BuildTWDistrictsResult["smallest"]

	{
		using db = new DatabaseClient<WOFDatabase>(tmpPath)
		db.exec("PRAGMA journal_mode = OFF")
		db.exec("PRAGMA synchronous = OFF")
		await createUnifiedSchema(db)

		db.exec(`CREATE TABLE database_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`)
		const meta = db.prepare(`INSERT INTO database_meta VALUES (?, ?)`)
		meta.run("source", "Overture Maps addresses, Taiwan (civil-affairs registers via OpenAddresses)")
		meta.run("license", TW_DISTRICTS_LICENSE)
		meta.run("source_release", release)
		meta.run("source_md5", sourceMD5)

		meta.run(
			"grouping",
			"address_levels[1] (縣市) × address_levels[2] (鄉鎮市區); centroid = median point, bbox = p5–p95"
		)

		const sprInsert = db.prepare(
			`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, 'locality', 'TW', ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0)`
		)

		const namesInsert = db.prepare(
			`INSERT INTO names (id, name, placetype, country, language, official, lastmodified) VALUES (?, ?, 'locality', 'TW', 'zho', ?, 0)`
		)

		const ancestorInsert = db.prepare(
			`INSERT INTO ancestors (id, ancestor_id, ancestor_placetype, lastmodified) VALUES (?, ?, ?, 0)`
		)

		db.exec("BEGIN")

		for (const g of groups) {
			const id = TW_DISTRICT_ID_BASE + inserted
			const regionID = matchTaiwanRegion(g.region, regions)

			sprInsert.run(id, regionID ?? -1, g.district, g.lat, g.lon, g.minLat, g.minLon, g.maxLat, g.maxLon)

			for (const [i, name] of districtNameVariants(g.district).entries()) {
				namesInsert.run(id, name, i === 0 ? 1 : 0)
			}

			if (regionID === undefined) {
				unmatched.set(g.region, (unmatched.get(g.region) ?? 0) + 1)
			} else {
				ancestorInsert.run(id, regionID, "region")

				if (typeof countryID === "number") {
					ancestorInsert.run(id, countryID, "country")
				}

				scoped++
			}

			if (!smallest || g.points < smallest.points) {
				smallest = { region: g.region, district: g.district, points: g.points }
			}

			inserted++
		}

		db.exec("COMMIT")
		await createUnifiedIndexes(db)
		buildPlaceSearchFTS(db, { drop: true })
		db.exec("ANALYZE")
	}

	await swapDatabaseIntoPlace(tmpPath, outPath)
	await sealDatabase(outPath)

	return {
		out: outPath,
		inserted,
		scoped,
		unmatchedRegions: [...unmatched].map(([region, count]) => ({ region, groups: count })),
		smallest,
		sourceMD5,
	}
}
