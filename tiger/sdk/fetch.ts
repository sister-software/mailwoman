/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pull a state's TIGER geometry into a `node:sqlite` database via the Kysely {@link DatabaseClient}.
 *
 *   Pared down from isp-nexus's `generate-tiger-tiles.ts` (its per-level column mapping is the spec)
 *   into the playpen `repo-tools` idiom: an async generator of progress events, idempotent, no
 *   SpatiaLite. Geometry is stored as GeoJSON text.
 *
 *   Flow: {@link TIGERStateLevelZIPPath} → download (skips a valid cached zip) → unzip → stream
 *   `ogr2ogr -f GeoJSONSeq` (mapping shapefile columns to the schema + reprojecting to WGS84) → batched
 *   inserts. Re-running a state replaces its rows.
 */

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { spawn } from "node:child_process"
import { createWriteStream, existsSync } from "node:fs"
import { mkdir, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { DatabaseSync } from "node:sqlite"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { AdminLevel1Code } from "../state.js"
import { TIGERFileExtension, TIGERLevel, TIGERStateLevelFileName, TIGERStateLevelZIPPath } from "../files.js"
import { TIGER_INITIALIZE_SQL, type TIGERBlockTable, type TIGERDatabase } from "./schema.js"

const CENSUS_HOST = "https://www2.census.gov"
const DEFAULT_DATA_ROOT = process.env.MAILWOMAN_DATA_ROOT ?? "/mnt/playpen/mailwoman-data"

export interface FetchTIGEROptions {
	/** Two-digit state FIPS, e.g. `"06"` (California). */
	stateFIPS: string
	/** TIGER level. Only {@link TIGERLevel.Block} (`tabblock20`) is supported today. */
	level?: TIGERLevel
	/** TIGER vintage. Default 2020 (matches the 2020 P.L. 94-171 block GEOIDs). */
	vintage?: number
	/** Output SQLite path. Default `<dataRoot>/tiger/tiger-<vintage>.db`. */
	outPath?: string
	/** Download cache + default output root. Default `$MAILWOMAN_DATA_ROOT` or `/mnt/playpen/mailwoman-data`. */
	dataRoot?: string
	/** Optional three-digit county FIPS filter, e.g. `"059"` — loads only that county's blocks. */
	county?: string
	/** Rows per insert. Default 1000. */
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

/** The isp-nexus column map for `tabblock20`, as an OGR-SQL SELECT. Geometry rides along implicitly. */
function blockSelectSQL(layer: string, county?: string): string {
	const where = county ? ` WHERE COUNTYFP20 = '${county}'` : ""
	return (
		`SELECT GEOID20 AS GEOID, STATEFP20 AS state_code, COUNTYFP20 AS county_code, ` +
		`SUBSTR(GEOID20, 6, 5) AS county_sub_division_code, SUBSTR(GEOID20, 6, 6) AS tract_code, ` +
		`SUBSTR(GEOID20, 12, 1) AS block_group_code, BLOCKCE20 AS block_code, ` +
		`UACE20 AS urbanized_area_code, UR20 AS urban_rural_code, ` +
		`HOUSING20 AS housing_unit_count, ALAND20 AS land_area_sqm, AWATER20 AS water_area_sqm, ` +
		`POP20 AS population FROM "${layer}"${where}`
	)
}

/** Spawn a command and resolve its stdout, rejecting on a nonzero exit. */
function runCapture(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args)
		let out = ""
		let err = ""
		child.stdout.on("data", (d) => (out += d))
		child.stderr.on("data", (d) => (err += d))
		child.on("error", reject)
		child.on("close", (code) =>
			code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 500)}`)),
		)
	})
}

async function downloadIfNeeded(url: string, dest: string): Promise<boolean> {
	if (existsSync(dest)) {
		try {
			await runCapture("unzip", ["-tq", dest])
			return true
		} catch {
			// corrupt cache — fall through and re-download
		}
	}
	const tmp = dest + ".tmp"
	const res = await fetch(url, { redirect: "follow" })
	if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${url}`)
	await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp))
	await rename(tmp, dest)
	return false
}

async function featureCount(shp: string, county?: string): Promise<number> {
	try {
		const where = county ? ["-where", `COUNTYFP20='${county}'`] : []
		const json = await runCapture("ogrinfo", ["-so", "-json", ...where, shp])
		return JSON.parse(json).layers?.[0]?.featureCount ?? 0
	} catch {
		return 0
	}
}

/**
 * Fetch one state's TIGER blocks into a SQLite DB. Yields progress; returns the final tally.
 */
export async function* fetchTIGER(options: FetchTIGEROptions): AsyncGenerator<FetchTIGEREvent, FetchTIGERResult> {
	const level = options.level ?? TIGERLevel.Block
	if (level !== TIGERLevel.Block) {
		throw new Error(`fetchTIGER currently supports ${TIGERLevel.Block} only (got "${level}")`)
	}

	const vintage = options.vintage ?? 2020
	const dataRoot = options.dataRoot ?? DEFAULT_DATA_ROOT
	const batchSize = options.batchSize ?? 1000
	const state = options.stateFIPS as AdminLevel1Code
	const cacheDir = join(dataRoot, "tiger", String(vintage), options.stateFIPS)
	const outPath = options.outPath ?? join(dataRoot, "tiger", `tiger-${vintage}.db`)

	await mkdir(cacheDir, { recursive: true })
	await mkdir(dirname(outPath), { recursive: true })

	const zipName = TIGERStateLevelFileName(state, level, TIGERFileExtension.Zip, vintage)
	const zipPath = join(cacheDir, zipName)
	const url = CENSUS_HOST + TIGERStateLevelZIPPath(state, level, vintage)

	const cached = await downloadIfNeeded(url, zipPath)
	yield { phase: "download", file: zipName, cached }

	await runCapture("unzip", ["-o", "-q", zipPath, "-d", cacheDir])
	const layer = TIGERStateLevelFileName(state, level, TIGERFileExtension.None, vintage)
	const shpPath = join(cacheDir, layer + ".shp")
	yield { phase: "extract", file: layer + ".shp" }

	const total = await featureCount(shpPath, options.county)

	const db = new DatabaseSync(outPath)
	db.exec(TIGER_INITIALIZE_SQL)
	const kdb = new DatabaseClient<TIGERDatabase>({ database: db })

	try {
		// Idempotent re-run: drop this state's rows first.
		await kdb.deleteFrom("tabblock20").where("state_code", "=", options.stateFIPS).execute()

		const child = spawn(
			"ogr2ogr",
			["-f", "GeoJSONSeq", "-t_srs", "EPSG:4326", "-sql", blockSelectSQL(layer, options.county), "/vsistdout/", shpPath],
			{ stdio: ["ignore", "pipe", "pipe"] },
		)
		let stderr = ""
		child.stderr.on("data", (d) => (stderr += d))
		const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 0)))

		let inserted = 0
		let batch: TIGERBlockTable[] = []
		const flush = async () => {
			if (!batch.length) return
			const rows = batch
			batch = []
			await kdb.insertInto("tabblock20").values(rows).execute()
			inserted += rows.length
		}

		for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
			if (!line) continue
			let feat: { properties?: Record<string, unknown>; geometry?: unknown }
			try {
				feat = JSON.parse(line)
			} catch {
				continue
			}
			const p = feat.properties
			if (!p || !feat.geometry) continue
			batch.push({
				GEOID: String(p.GEOID),
				state_code: String(p.state_code),
				county_code: String(p.county_code),
				county_sub_division_code: String(p.county_sub_division_code ?? ""),
				tract_code: String(p.tract_code ?? ""),
				block_group_code: String(p.block_group_code ?? ""),
				block_code: String(p.block_code ?? ""),
				urbanized_area_code: (p.urbanized_area_code as string) || null,
				urban_rural_code: (p.urban_rural_code as string) || null,
				housing_unit_count: Number(p.housing_unit_count ?? 0),
				land_area_sqm: Number(p.land_area_sqm ?? 0),
				water_area_sqm: Number(p.water_area_sqm ?? 0),
				population: Number(p.population ?? 0),
				geometry: JSON.stringify(feat.geometry),
			})
			if (batch.length >= batchSize) {
				await flush()
				yield { phase: "load", inserted, total }
			}
		}
		await flush()

		const code = await exited
		if (code !== 0) throw new Error(`ogr2ogr exited ${code}: ${stderr.slice(0, 500)}`)

		yield { phase: "load", inserted, total }
		db.exec("PRAGMA wal_checkpoint(TRUNCATE);")
		return { outPath, table: "tabblock20", inserted }
	} finally {
		await kdb.destroy()
	}
}
