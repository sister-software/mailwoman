/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { dataRootPath } from "@mailwoman/core/data-root"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { extractZipEntries } from "@mailwoman/core/fs/zip"
import { stringifyJSON } from "@mailwoman/core/json"
import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr-stream"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { PathBuilder } from "path-ts"

import { downloadIfNeeded } from "#sdk/download"
import type { TIGERBlockTable, TIGERDatabase, TIGERPlaceTable, TIGERStreetTable } from "#sdk/schema"
import { initializeTIGERSchema, TIGER_PRAGMAS } from "#sdk/schema"

const CENSUS_HOST = "https://www2.census.gov"
const DEFAULT_DATA_ROOT = dataRootPath()

/**
 * Names a TIGER/Line product that {@link fetchTIGER} can load; only `tabblock20` keeps geometry.
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

/**
 * Configures {@link fetchTIGER}.
 *
 * `county` filters only the `tabblock20` level, and `vintage` defaults to
 * 2020 for blocks and 2024 otherwise.
 */
export interface FetchTIGEROptions {
	/**
	 * The two-digit state FIPS code, such as `"06"`.
	 */
	stateFIPS: string

	/**
	 * The TIGER level to fetch, default `tabblock20`.
	 */
	level?: TIGERFetchLevel

	/**
	 * The TIGER vintage year, default 2020 for blocks to match the 2020 redistricting data and 2024 otherwise.
	 */
	vintage?: number

	/**
	 * The output SQLite path, default `<dataRoot>/tiger/tiger.db`, which is
	 * where the corpus `tiger` adapter reads.
	 */
	outPath?: string

	/**
	 * The root for the download cache and the default output, default the Mailwoman data root.
	 */
	dataRoot?: string

	/**
	 * A three-digit county FIPS filter that applies only to the `tabblock20` level.
	 */
	county?: string

	/**
	 * Rows per insert batch, default 1000.
	 */
	batchSize?: number
}

/**
 * Reports progress from {@link fetchTIGER}: a file downloaded or found in the cache,
 * a shapefile extracted, or rows inserted.
 */
export type FetchTIGEREvent =
	| { phase: "download"; file: string; cached: boolean }
	| { phase: "extract"; file: string }
	| { phase: "load"; inserted: number; total: number }

/**
 * Reports the database path, table name and inserted row count when {@link fetchTIGER} finishes.
 */
export interface FetchTIGERResult {
	outPath: string
	table: string
	inserted: number
}

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
				geometry: stringifyJSON(geometry),
			}
	}
}

async function discoverCounties(state: string, vintage: number): Promise<string[]> {
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
 * Downloads one state's TIGER/Line files at `level` and loads them into a SQLite
 * database, yielding progress events.
 *
 * It first deletes that state's existing rows from the target table, so a rerun
 * replaces the state rather than duplicating it.
 */
export async function* fetchTIGER(options: FetchTIGEROptions): AsyncGenerator<FetchTIGEREvent, FetchTIGERResult> {
	const level = options.level ?? "tabblock20"
	const vintage = options.vintage ?? (level === "tabblock20" ? 2020 : 2024)
	const dataRoot = PathBuilder.from(options.dataRoot ?? DEFAULT_DATA_ROOT)
	const batchSize = options.batchSize ?? 1000
	const state = options.stateFIPS
	const table = LEVEL_TABLE[level]

	const cacheDir = dataRoot("tiger", String(vintage), state)

	const outPath = PathBuilder.from(options.outPath ?? dataRoot("tiger", "tiger.db"))
	await makeDirectories(cacheDir)
	await makeDirectories(outPath.dirname())

	const geoCodes = level === "addrfeat" ? await discoverCounties(state, vintage) : [""]

	if (level === "addrfeat" && !geoCodes.length) {
		throw new Error(`No ADDRFEAT counties found for state ${state} vintage ${vintage}`)
	}

	const kdb = new DatabaseClient<TIGERDatabase>(outPath)
	kdb.exec(TIGER_PRAGMAS)
	await initializeTIGERSchema(kdb)

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
			const zipPath = cacheDir(zipName)
			const url = `${CENSUS_HOST}/geo/tiger/TIGER${vintage}/${LEVEL_DIR[level]}/${zipName}`

			const cached = await downloadIfNeeded(url, zipPath)
			yield { phase: "download", file: zipName, cached }

			await extractZipEntries(zipPath, cacheDir)
			const layer = `tl_${vintage}_${unit}_${level}`
			const shpPath = cacheDir(layer + ".shp")
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

		return { outPath: outPath.toString(), table, inserted }
	} finally {
		await kdb.destroy()
	}
}
