/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pull TIGER geometry/attributes into a `node:sqlite` database via the Kysely
 *   {@link DatabaseClient}.
 *
 *   Replaces the ad-hoc wget and the retired corpus TIGER build script. Pared down from isp-nexus's
 *   `generate-tiger-tiles.ts` (its per-level column mapping is the spec) into the playpen
 *   `repo-tools` idiom: an async generator of progress events, idempotent, no SpatiaLite.
 *
 *   Three levels:
 *
 *   - `tabblock20` (per state) — tabulation blocks → `tabblock20`, geometry as GeoJSON text.
 *   - `place` (per state) — incorporated/census places → `tiger_places` (attribute-only).
 *   - `addrfeat` (per county) — named street segments + ZIPs → `tiger_streets` (attribute-only).
 *
 *   `tiger_streets` + `tiger_places` match the schema the corpus `tiger` adapter reads, so this is a
 *   drop-in replacement for the retired corpus TIGER build script.
 *
 *   Flow per source unit: download (skips a valid cached zip) → unzip → stream `ogr2ogr -f
 *   GeoJSONSeq` (mapping shapefile columns to the schema, WGS84 for geometry levels) → batched
 *   inserts. Re-running a state replaces its rows.
 */

import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { extractZipEntries } from "@mailwoman/core/fs/zip"
import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr-stream"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { dirname, join } from "path-ts"

import { downloadIfNeeded } from "#sdk/download"
import type { TIGERBlockTable, TIGERDatabase, TIGERPlaceTable, TIGERStreetTable } from "#sdk/schema"
import { initializeTIGERSchema, TIGER_PRAGMAS } from "#sdk/schema"

const CENSUS_HOST = "https://www2.census.gov"
const DEFAULT_DATA_ROOT = mailwomanDataRoot()

/**
 * Supported TIGER levels. `tabblock20` is per state + carries geometry; `place`/`addrfeat` are attribute-only.
 */
export type TIGERFetchLevel = "tabblock20" | "place" | "addrfeat"

const LEVEL_DIR: Record<TIGERFetchLevel, string> = {
	tabblock20: "TABBLOCK20",
	place: "PLACE",
	addrfeat: "ADDRFEAT",
}

const LEVEL_TABLE: Record<TIGERFetchLevel, keyof TIGERDatabase> = {
	tabblock20: "tabblock20",
	place: "tiger_places",
	addrfeat: "tiger_streets",
}

export interface FetchTIGEROptions {
	/**
	 * Two-digit state FIPS, e.g. `"06"`.
	 */
	stateFIPS: string
	/**
	 * TIGER level. Default `tabblock20`.
	 */
	level?: TIGERFetchLevel
	/**
	 * Vintage. Default 2020 for blocks (matches the 2020 P.L.), 2024 for place/addrfeat (current).
	 */
	vintage?: number
	/**
	 * Output SQLite path. Default `<dataRoot>/tiger/tiger.db` (the name the corpus `tiger` adapter reads).
	 */
	outPath?: string
	/**
	 * Download cache + default output root.
	 */
	dataRoot?: string
	/**
	 * Optional three-digit county FIPS filter (blocks only — addrfeat is already per-county).
	 */
	county?: string
	/**
	 * Rows per insert. Default 1000.
	 */
	batchSize?: number
}

export type FetchTIGEREvent =
	| { phase: "download"; file: string; cached: boolean }
	| { phase: "extract"; file: string }
	| { phase: "load"; inserted: number; total: number }

export interface FetchTIGERResult {
	outPath: string
	table: string
	inserted: number
}

/**
 * The isp-nexus column map for `tabblock20`. Geometry rides along implicitly.
 */
function blockSelectSQL(layer: string, county?: string): string {
	const where = county ? ` WHERE COUNTYFP20 = '${county}'` : ""

	return (
		`SELECT GEOID20 AS GEOID, STATEFP20 AS state_code, COUNTYFP20 AS county_code, ` +
		`SUBSTR(GEOID20, 6, 6) AS tract_code, ` +
		`SUBSTR(GEOID20, 12, 1) AS block_group_code, BLOCKCE20 AS block_code, ` +
		`UACE20 AS urbanized_area_code, UR20 AS urban_rural_code, ` +
		`HOUSING20 AS housing_unit_count, ALAND20 AS land_area_sqm, AWATER20 AS water_area_sqm, ` +
		`POP20 AS population FROM "${layer}"${where}`
	)
}

function selectSQL(level: TIGERFetchLevel, layer: string, county?: string): string {
	switch (level) {
		case "tabblock20":
			return blockSelectSQL(layer, county)
		case "place":
			return `SELECT GEOID AS geoid, NAME AS name, STATEFP AS statefp, LSAD AS lsad, NAMELSAD AS namelsad, CLASSFP AS classfp FROM "${layer}"`
		case "addrfeat":
			// ADDRFEAT has no STATEFP column — injected per-row from the state we're fetching.
			return `SELECT LINEARID AS linearid, FULLNAME AS fullname, ZIPL AS zipl, ZIPR AS zipr FROM "${layer}" WHERE FULLNAME IS NOT NULL AND FULLNAME != ''`
	}
}

type Row = TIGERBlockTable | TIGERPlaceTable | TIGERStreetTable

function buildRow(level: TIGERFetchLevel, p: Record<string, unknown>, geometry: unknown, state: string): Row {
	switch (level) {
		case "place":
			return {
				geoid: String(p.geoid),
				name: String(p.name ?? ""),
				statefp: String(p.statefp ?? state),
				lsad: (p.lsad as string) || null,
				namelsad: (p.namelsad as string) || null,
				classfp: (p.classfp as string) || null,
			}
		case "addrfeat":
			return {
				linearid: String(p.linearid),
				fullname: String(p.fullname ?? ""),
				zipl: (p.zipl as string) || null,
				zipr: (p.zipr as string) || null,
				statefp: state,
			}
		case "tabblock20":
			return {
				GEOID: String(p.GEOID),
				state_code: String(p.state_code),
				county_code: String(p.county_code),
				tract_code: String(p.tract_code ?? ""),
				block_group_code: String(p.block_group_code ?? ""),
				block_code: String(p.block_code ?? ""),
				urbanized_area_code: (p.urbanized_area_code as string) || null,
				urban_rural_code: (p.urban_rural_code as string) || null,
				housing_unit_count: Number(p.housing_unit_count ?? 0),
				land_area_sqm: Number(p.land_area_sqm ?? 0),
				water_area_sqm: Number(p.water_area_sqm ?? 0),
				population: Number(p.population ?? 0),
				geometry: JSON.stringify(geometry),
			}
	}
}

/**
 * Scrape the ADDRFEAT directory listing for a state's county FIPS codes.
 */
async function discoverCounties(state: string, vintage: number): Promise<string[]> {
	// The LISTING only — a small HTML index. The per-county archives below stay on raw `fetch`, streaming to disk.
	const html = await new APIClient({ displayName: "tiger-listing", retry: true })
		.fetch<string>({ url: `${CENSUS_HOST}/geo/tiger/TIGER${vintage}/ADDRFEAT/`, responseType: "text" })
		.then(pluckResponseData)

	const re = new RegExp(`tl_${vintage}_${state}(\\d{3})_addrfeat\\.zip`, "g")
	const counties = new Set<string>()

	for (let m = re.exec(html); m; m = re.exec(html)) {
		counties.add(m[1]!)
	}

	return [...counties].toSorted()
}

/**
 * Fetch one state's TIGER data at `level` into a SQLite DB. Yields progress; returns the final tally.
 */
export async function* fetchTIGER(options: FetchTIGEROptions): AsyncGenerator<FetchTIGEREvent, FetchTIGERResult> {
	const level = options.level ?? "tabblock20"
	const vintage = options.vintage ?? (level === "tabblock20" ? 2020 : 2024)
	const dataRoot = options.dataRoot ?? DEFAULT_DATA_ROOT
	const batchSize = options.batchSize ?? 1000
	const state = options.stateFIPS
	const table = LEVEL_TABLE[level]

	const cacheDir = join(dataRoot, "tiger", String(vintage), state)
	// Default to a stable, vintage-agnostic `tiger.db` — the filename the corpus `tiger` adapter reads
	// (run-corpus-build → `${ROOT}/tiger/tiger.db`). The vintage is a content detail, not a path one;
	// the per-table idempotent delete keeps a re-fetch (newer vintage) clean. The download CACHE stays
	// vintage-partitioned below so zips don't collide across vintages.
	const outPath = options.outPath ?? join(dataRoot, "tiger", "tiger.db")
	await makeDirectories(cacheDir)
	await makeDirectories(dirname(outPath))

	// Source units: one (per-state) for block/place; one per county for addrfeat.
	const geoCodes = level === "addrfeat" ? await discoverCounties(state, vintage) : [""]

	if (level === "addrfeat" && !geoCodes.length) {
		throw new Error(`No ADDRFEAT counties found for state ${state} vintage ${vintage}`)
	}

	const kdb = new DatabaseClient<TIGERDatabase>(outPath)
	kdb.exec(TIGER_PRAGMAS)
	await initializeTIGERSchema(kdb)

	/**
	 * `level` picks the table AND the row shape, but nothing ties them at the type level: {@link buildRow} returns the
	 * union and Kysely needs the arm's concrete row. The narrowings below are sound only because `buildRow` switches on
	 * the SAME `level` — keep the two switches in step, or a row shape reaches the wrong table.
	 */
	const insertBatch = async (rows: Row[]): Promise<void> => {
		if (level === "tabblock20") {
			await kdb
				.insertInto("tabblock20")
				.values(rows as TIGERBlockTable[])
				.execute()
		} else if (level === "place") {
			await kdb
				.insertInto("tiger_places")
				.values(rows as TIGERPlaceTable[])
				.execute()
		} else {
			await kdb
				.insertInto("tiger_streets")
				.values(rows as TIGERStreetTable[])
				.execute()
		}
	}

	try {
		// Idempotent re-run: drop this state's rows first (state_code for blocks, statefp otherwise).
		if (level === "tabblock20") {
			await kdb.deleteFrom("tabblock20").where("state_code", "=", state).execute()
		} else if (level === "place") {
			await kdb.deleteFrom("tiger_places").where("statefp", "=", state).execute()
		} else {
			await kdb.deleteFrom("tiger_streets").where("statefp", "=", state).execute()
		}

		let inserted = 0
		let batch: Row[] = []

		const flush = async () => {
			if (!batch.length) return
			const rows = batch
			batch = []
			await insertBatch(rows)
			inserted += rows.length
		}

		for (const geo of geoCodes) {
			const unit = level === "addrfeat" ? state + geo : state
			const zipName = `tl_${vintage}_${unit}_${level}.zip`
			const zipPath = join(cacheDir, zipName)
			const url = `${CENSUS_HOST}/geo/tiger/TIGER${vintage}/${LEVEL_DIR[level]}/${zipName}`

			const cached = await downloadIfNeeded(url, zipPath)
			yield { phase: "download", file: zipName, cached }

			await extractZipEntries(zipPath, cacheDir)
			const layer = `tl_${vintage}_${unit}_${level}`
			const shpPath = join(cacheDir, layer + ".shp")
			yield { phase: "extract", file: layer + ".shp" }

			const args = [
				"-f",
				"GeoJSONSeq",
				"-t_srs",
				"EPSG:4326",
				"-sql",
				selectSQL(level, layer, options.county),
				"/vsistdout/",
				shpPath,
			]

			for await (const feat of ogr2ogrGeoJSONSeq<{ properties?: Record<string, unknown>; geometry?: unknown }>(
				args,
				layer
			)) {
				if (!feat.properties) continue

				if (level === "tabblock20" && !feat.geometry) continue
				batch.push(buildRow(level, feat.properties, feat.geometry, state))

				if (batch.length >= batchSize) {
					await flush()
					yield { phase: "load", inserted, total: 0 }
				}
			}

			await flush()
			yield { phase: "load", inserted, total: 0 }
		}

		kdb.exec("PRAGMA wal_checkpoint(TRUNCATE);")

		return { outPath, table, inserted }
	} finally {
		await kdb.destroy()
	}
}
