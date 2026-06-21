/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pull a state's Census 2020 P.L. 94-171 redistricting counts (table P2 — Hispanic-or-Latino by
 *   race, per block) into the `pl_block` table of a TIGER {@link DatabaseClient} DB, keyed on the
 *   same 15-char block `GEOID` as {@link fetchTIGER}'s `tabblock20`. Join the two for block-level
 *   race + geometry (e.g. a dot-density map).
 *
 *   Keyless public data. The per-state ZIP holds a pipe-delimited geographic header
 *   (`<st>geo<yr>.pl`) and three data segments; segment 1 (`<st>00001<yr>.pl`) carries P1 + P2. We
 *   join the header (filtered to SUMLEV 750 = block) to segment 1 by LOGRECNO. Field offsets are
 *   fixed by the 2020 P.L. layout (verified against the real files).
 *
 *   https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171/
 */

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { spawn } from "node:child_process"
import { createReadStream, createWriteStream, existsSync } from "node:fs"
import { mkdir, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { DatabaseSync } from "node:sqlite"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { AdminLevel1CodeToAbbreviation, StateName, type AdminLevel1Code } from "../state.js"
import { initializeTIGERSchema, TIGER_PRAGMAS, type PLBlockTable, type TIGERDatabase } from "./schema.js"

const REDISTRICTING_BASE =
	"https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171"
const DEFAULT_DATA_ROOT = process.env.MAILWOMAN_DATA_ROOT ?? "/mnt/playpen/mailwoman-data"

// P.L. 94-171 (2020) pipe-delimited field offsets (0-based).
// Geographic header: …|SUMLEV(2)|…|LOGRECNO(7)|GEOID(8)|GEOCODE(9)|… — GEOCODE is the bare 15-char
// block FIPS (matches TIGER GEOID20); SUMLEV 750 = tabulation block.
const GEO_SUMLEV = 2
const GEO_LOGRECNO = 7
const GEO_GEOCODE = 9
// Segment 1: FILEID|STUSAB|CHARITER|CIFSN|LOGRECNO(4)| P1×71 | P2×73. P0020001 is at index 76.
const SEG_LOGRECNO = 4
const P2 = (fieldNo: number) => 76 + (fieldNo - 1)
// The eight P2 categories that partition the total (P0020001), in `pl_block` column order.
const CATEGORY_INDEX = {
	pop_total: P2(1),
	hispanic: P2(2), // Hispanic or Latino (any race)
	white: P2(5), // Not Hispanic: White alone
	black: P2(6),
	aian: P2(7),
	asian: P2(8),
	nhpi: P2(9),
	other: P2(10),
	multi: P2(11), // Two or more races
} as const

export interface FetchRedistrictingOptions {
	/** Two-digit state FIPS, e.g. `"06"`. */
	stateFIPS: string
	/** Decennial vintage. Default 2020 (the only P.L. 94-171 release this parses). */
	vintage?: number
	/** Output SQLite path. Default `<dataRoot>/tiger/tiger.db` (same DB as `fetchTIGER`). */
	outPath?: string
	/** Download cache + default output root. */
	dataRoot?: string
	/** Optional three-digit county FIPS filter, e.g. `"059"`. */
	county?: string
	/** Rows per insert. Default 2000. */
	batchSize?: number
}

export type FetchRedistrictingEvent =
	| { phase: "download"; file: string; cached: boolean }
	| { phase: "extract"; file: string }
	| { phase: "header"; blocks: number }
	| { phase: "load"; inserted: number; total: number }

export interface FetchRedistrictingResult {
	outPath: string
	table: string
	inserted: number
}

function runCapture(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args)
		let out = ""
		let err = ""
		child.stdout.on("data", (d) => (out += d))
		child.stderr.on("data", (d) => (err += d))
		child.on("error", reject)
		child.on("close", (code) =>
			code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 500)}`))
		)
	})
}

async function downloadIfNeeded(url: string, dest: string): Promise<boolean> {
	if (existsSync(dest)) {
		try {
			await runCapture("unzip", ["-tq", dest])
			return true
		} catch {
			// corrupt cache — re-download
		}
	}
	const tmp = dest + ".tmp"
	const res = await fetch(url, { redirect: "follow" })
	if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${url}`)
	await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp))
	await rename(tmp, dest)
	return false
}

async function eachLine(path: string, fn: (line: string) => void): Promise<void> {
	for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
		if (line) fn(line)
	}
}

/**
 * Fetch one state's P.L. 94-171 block race counts into `pl_block`. Yields progress; returns the
 * tally.
 */
export async function* fetchRedistricting(
	options: FetchRedistrictingOptions
): AsyncGenerator<FetchRedistrictingEvent, FetchRedistrictingResult> {
	const vintage = options.vintage ?? 2020
	const dataRoot = options.dataRoot ?? DEFAULT_DATA_ROOT
	const batchSize = options.batchSize ?? 2000
	const state = options.stateFIPS

	const abbr = AdminLevel1CodeToAbbreviation[state as AdminLevel1Code]
	if (!abbr) throw new Error(`Unknown state FIPS "${state}"`)
	const stateName = StateName[abbr as keyof typeof StateName]
	const dirName = stateName.replace(/ /g, "_")
	const fileAbbr = abbr.toLowerCase()

	const cacheDir = join(dataRoot, "census", "redistricting", String(vintage), state)
	// Same stable `tiger.db` default as fetchTIGER — pl_block lives alongside tabblock20 in one DB.
	const outPath = options.outPath ?? join(dataRoot, "tiger", "tiger.db")
	await mkdir(cacheDir, { recursive: true })
	await mkdir(dirname(outPath), { recursive: true })

	const zipName = `${fileAbbr}${vintage}.pl.zip`
	const zipPath = join(cacheDir, zipName)
	const url = `${REDISTRICTING_BASE}/${dirName}/${zipName}`

	const cached = await downloadIfNeeded(url, zipPath)
	yield { phase: "download", file: zipName, cached }

	await runCapture("unzip", ["-o", "-q", zipPath, "-d", cacheDir])
	const geoPath = join(cacheDir, `${fileAbbr}geo${vintage}.pl`)
	const seg1Path = join(cacheDir, `${fileAbbr}00001${vintage}.pl`)
	yield { phase: "extract", file: `${fileAbbr}geo${vintage}.pl` }

	// Pass 1: header → LOGRECNO → GEOID for the blocks we want.
	const prefix = options.county ? state + options.county : state
	const logToGeoid = new Map<string, string>()
	await eachLine(geoPath, (line) => {
		const f = line.split("|")
		if (f[GEO_SUMLEV] !== "750") return
		const geoid = f[GEO_GEOCODE] ?? ""
		if (!geoid.startsWith(prefix)) return
		logToGeoid.set(f[GEO_LOGRECNO] ?? "", geoid)
	})
	const total = logToGeoid.size
	yield { phase: "header", blocks: total }

	const db = new DatabaseSync(outPath)
	db.exec(TIGER_PRAGMAS)
	const kdb = new DatabaseClient<TIGERDatabase>({ database: db })
	await initializeTIGERSchema(kdb)

	try {
		// Idempotent re-run: drop the rows we're about to (re)load.
		await kdb
			.deleteFrom("pl_block")
			.where("GEOID", "like", prefix + "%")
			.execute()

		let inserted = 0
		let batch: PLBlockTable[] = []
		const flush = async () => {
			if (!batch.length) return
			const rows = batch
			batch = []
			await kdb.insertInto("pl_block").values(rows).execute()
			inserted += rows.length
		}

		// Pass 2: segment 1 → P2 counts for the mapped LOGRECNOs, flushing as we go.
		for await (const line of createInterface({ input: createReadStream(seg1Path), crlfDelay: Infinity })) {
			if (!line) continue
			const f = line.split("|")
			const geoid = logToGeoid.get(f[SEG_LOGRECNO] ?? "")
			if (!geoid) continue
			batch.push({
				GEOID: geoid,
				pop_total: Number(f[CATEGORY_INDEX.pop_total] ?? 0),
				hispanic: Number(f[CATEGORY_INDEX.hispanic] ?? 0),
				white: Number(f[CATEGORY_INDEX.white] ?? 0),
				black: Number(f[CATEGORY_INDEX.black] ?? 0),
				aian: Number(f[CATEGORY_INDEX.aian] ?? 0),
				asian: Number(f[CATEGORY_INDEX.asian] ?? 0),
				nhpi: Number(f[CATEGORY_INDEX.nhpi] ?? 0),
				other: Number(f[CATEGORY_INDEX.other] ?? 0),
				multi: Number(f[CATEGORY_INDEX.multi] ?? 0),
			})
			if (batch.length >= batchSize) {
				await flush()
				yield { phase: "load", inserted, total }
			}
		}
		await flush()

		yield { phase: "load", inserted, total }
		db.exec("PRAGMA wal_checkpoint(TRUNCATE);")
		return { outPath, table: "pl_block", inserted }
	} finally {
		await kdb.destroy()
	}
}
