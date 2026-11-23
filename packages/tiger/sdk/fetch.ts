// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { dataRootPath } from "@mailwoman/core/data-root"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { extractZipEntries } from "@mailwoman/core/fs/zip"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr/stream"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { PathBuilder } from "path-ts"

import { tigerDatabaseRoot } from "#paths"
import type { TIGERBlockTable, TIGERDatabase, TIGERPlaceTable, TIGERStreetTable } from "#schema"
import { initializeTIGERSchema, TIGER_PRAGMAS } from "#schema"
import { downloadIfNeeded } from "#sdk/download"

const CENSUS_HOST = "https://www2.census.gov"
const DEFAULT_DATA_ROOT = dataRootPath()

/**
 * A TIGER/Line product that {@link fetchTIGER} can load.
 * Only the `tabblock20` level keeps geometry.
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
 * Options for {@link fetchTIGER}.
 */
export interface FetchTIGEROptions {
	/**
	 * The two-digit state FIPS code, such as `"06"`.
	 */
	stateFIPS: string

	/**
	 * The TIGER level to fetch.
	 *
	 * @defaultValue `tabblock20`
	 */
	level?: TIGERFetchLevel

	/**
	 * The TIGER vintage year.
	 *
	 * Other levels default to 2024.
	 *
	 * @defaultValue `2020` for blocks to match redistricting data.
	 */
	vintage?: number

	/**
	 * The output SQLite path.
	 *
	 * @defaultValue `<dataRoot>/db/tiger/tiger.db`, which the corpus `tiger` adapter reads.
	 */
	outPath?: string

	/**
	 * The root of the download cache and the default output.
	 *
	 * @defaultValue the Mailwoman data root.
	 */
	dataRoot?: string

	/**
	 * A three-digit county FIPS filter that applies only to the `tabblock20` level.
	 */
	county?: string

	/**
	 * The number of rows per insert batch.
	 *
	 * @defaultValue `1000`
	 */
	batchSize?: number
}

/**
 * A progress event from {@link fetchTIGER}.
 *
 * Each event reports a file downloaded or found in the cache, a shapefile extracted, or rows inserted.
 */
export type FetchTIGEREvent =
	| { phase: "download"; file: string; cached: boolean }
	| { phase: "extract"; file: string }
	| { phase: "load"; inserted: number; total: number }

/**
 * The database path, table name and inserted row count that {@link fetchTIGER} returns.
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

/**
 * Downloads one TIGER/Line shapefile archive into `cacheDir` unless a valid copy is there, and extracts it.
 *
 * @param directory The product directory under `TIGER<vintage>/`, such as `PLACE`.
 * @param product The product name in the file name, such as `place`.
 * @param unit The state FIPS code, a state and county code, or `us` for a national file.
 */
async function downloadTIGERLayer(
	directory: string,
	product: string,
	unit: string,
	vintage: number,
	cacheDir: PathBuilder
): Promise<{ layer: string; shpPath: PathBuilder; cached: boolean }> {
	const layer = `tl_${vintage}_${unit}_${product}`
	const zipPath = cacheDir(`${layer}.zip`)
	const cached = await downloadIfNeeded(`${CENSUS_HOST}/geo/tiger/TIGER${vintage}/${directory}/${layer}.zip`, zipPath)

	await extractZipEntries(zipPath, cacheDir)

	return { layer, shpPath: cacheDir(`${layer}.shp`), cached }
}

/**
 * A TIGER/Line boundary product that {@link readTIGERBoundaries} reads with its geometry.
 */
export const TIGERBoundaryLevel = {
	County: "county",
	CountySubdivision: "cousub",
	Place: "place",
} as const

export type TIGERBoundaryLevel = (typeof TIGERBoundaryLevel)[keyof typeof TIGERBoundaryLevel]

/**
 * One boundary {@link readTIGERBoundaries} yields, in EPSG:4326.
 */
export interface TIGERBoundary {
	level: TIGERBoundaryLevel
	geoid: string
	/**
	 * The name with its legal/statistical area description (`NAMELSAD`), such as `Adjuntas Municipio`.
	 */
	name: string
	statefp: string
	geometry: { type: string; coordinates: unknown }
}

/**
 * Options for {@link readTIGERBoundaries}.
 */
export interface ReadTIGERBoundariesOptions {
	level: TIGERBoundaryLevel
	/**
	 * The two-digit state or territory FIPS code, such as `"72"`.
	 */
	stateFIPS: string
	/**
	 * @defaultValue `2024`
	 */
	vintage?: number
	/**
	 * The root of the download cache.
	 *
	 * @defaultValue the Mailwoman data root.
	 */
	dataRoot?: string
}

/**
 * Downloads one state's or territory's TIGER/Line boundaries at `level` and yields each with its geometry.
 *
 * Counties come from the national file, filtered to the state.
 * County subdivisions and places come from the state's own file.
 *
 * @throws When the Census Bureau serves no file for the state at `level`.
 */
export async function* readTIGERBoundaries(options: ReadTIGERBoundariesOptions): AsyncGenerator<TIGERBoundary> {
	const { level, stateFIPS } = options
	const vintage = options.vintage ?? 2024
	const unit = level === TIGERBoundaryLevel.County ? "us" : stateFIPS
	const cacheDir = PathBuilder.from(options.dataRoot ?? DEFAULT_DATA_ROOT)("tiger", String(vintage), unit)

	await makeDirectories(cacheDir)

	const { layer, shpPath } = await downloadTIGERLayer(level.toUpperCase(), level, unit, vintage, cacheDir)

	const sql = `SELECT GEOID AS geoid, NAMELSAD AS name, STATEFP AS statefp FROM "${layer}" WHERE STATEFP = '${stateFIPS}'`

	for await (const feature of ogr2ogrGeoJSONSeq<{
		properties?: { geoid?: string; name?: string; statefp?: string }
		geometry?: TIGERBoundary["geometry"] | null
	}>(["-f", "GeoJSONSeq", "-t_srs", "EPSG:4326", "-sql", sql, "/vsistdout/", shpPath], layer)) {
		const { properties, geometry } = feature

		if (!properties?.geoid || !geometry) {
			throw new Error(`${layer}: a feature has no GEOID or no geometry`)
		}

		yield {
			level,
			geoid: properties.geoid,
			name: properties.name ?? "",
			statefp: properties.statefp ?? stateFIPS,
			geometry,
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
 * Downloads one state's TIGER/Line files at `level`, loads them into a SQLite database
 * and yields progress events.
 *
 * It first deletes the state's existing rows from the target table so that a rerun replaces them.
 */
export async function* fetchTIGER(options: FetchTIGEROptions): AsyncGenerator<FetchTIGEREvent, FetchTIGERResult> {
	const level = options.level ?? "tabblock20"
	const vintage = options.vintage ?? (level === "tabblock20" ? 2020 : 2024)
	const dataRoot = PathBuilder.from(options.dataRoot ?? DEFAULT_DATA_ROOT)
	const batchSize = options.batchSize ?? 1000
	const state = options.stateFIPS
	const table = LEVEL_TABLE[level]

	const cacheDir = dataRoot("tiger", String(vintage), state)

	const outPath = PathBuilder.from(options.outPath ?? tigerDatabaseRoot(dataRoot)("tiger.db"))
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
			const { layer, shpPath, cached } = await downloadTIGERLayer(LEVEL_DIR[level], level, unit, vintage, cacheDir)

			yield { phase: "download", file: `${layer}.zip`, cached }
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
