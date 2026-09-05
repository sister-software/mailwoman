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

import { mailwomanDataRoot } from "@mailwoman/core/data-root"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { extractZipEntries } from "@mailwoman/core/fs/zip"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { dirname, join } from "path-ts"
import { TextSpliterator } from "spliterator"

import { downloadIfNeeded } from "#sdk/download"
import { initializeTIGERSchema, TIGER_PRAGMAS, type PLBlockTable, type TIGERDatabase } from "#sdk/schema"
import { AdminLevel1CodeToAbbreviation, StateName, type AdminLevel1Code } from "#state"

const REDISTRICTING_BASE =
	"https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171"

const DEFAULT_DATA_ROOT = mailwomanDataRoot()

/**
 * P.L. 94-171 (2020) pipe-delimited field offsets (0-based). Geographic header:
 * …|SUMLEV(2)|…|LOGRECNO(7)|GEOID(8)|GEOCODE(9)|… — GEOCODE is the bare 15-char block FIPS (matches TIGER GEOID20);
 * SUMLEV 750 = tabulation block.
 */
const GEO_SUMLEV = 2
const GEO_LOGRECNO = 7
const GEO_GEOCODE = 9
/**
 * Segment 1: FILEID|STUSAB|CHARITER|CIFSN|LOGRECNO(4)| P1×71 | P2×73. P0020001 is at index 76.
 */
const SEG_LOGRECNO = 4
const P2 = (fieldNo: number) => 76 + (fieldNo - 1)

/**
 * Segment 2: FILEID|STUSAB|CHARITER|CIFSN|LOGRECNO(4)| P3×71 | P4×73 | H1×3 — 152 fields, H1 at the tail. Verified
 * against the real file: `ca000022020.pl`'s state row reads 14,392,140 / 13,475,623 / 916,517, the published CA 2020
 * figures. `occupied + vacant === housing_units` is the invariant that distinguishes a correct offset from a plausible
 * one, and {@link parseH1} refuses a row where it does not hold.
 */
export const SEG2_FIELD_COUNT = 152
/**
 * H0010001 — total housing units, the third-from-last field of a segment-2 row.
 */
export const H1_TOTAL = SEG2_FIELD_COUNT - 3
/**
 * H0010002 — occupied housing units, the second-from-last field.
 */
export const H1_OCCUPIED = SEG2_FIELD_COUNT - 2
/**
 * H0010003 — vacant housing units, the last field (and so the one that carries a CRLF file's trailing CR).
 */
export const H1_VACANT = SEG2_FIELD_COUNT - 1

export interface H1Counts {
	housing_units: number
	occupied: number
	vacant: number
}

/**
 * The three H1 counts from one segment-2 row. The last field carries CRLF's trailing CR when the file has one, so each
 * field is trimmed before it is read as a number; a row whose counts do not add up is refused rather than stored.
 */
export function parseH1(fields: readonly string[]): H1Counts {
	if (fields.length !== SEG2_FIELD_COUNT) {
		throw new Error(`segment 2 row has ${fields.length} fields, expected ${SEG2_FIELD_COUNT}`)
	}

	const counts = {
		housing_units: Number(fields[H1_TOTAL]!.trim()),
		occupied: Number(fields[H1_OCCUPIED]!.trim()),
		vacant: Number(fields[H1_VACANT]!.trim()),
	}

	if (![counts.housing_units, counts.occupied, counts.vacant].every(Number.isInteger)) {
		throw new Error(`segment 2 row carries a non-integer H1 count: ${fields.slice(H1_TOTAL).join("|")}`)
	}

	if (counts.occupied + counts.vacant !== counts.housing_units) {
		throw new Error(
			`segment 2 row breaks the H1 invariant: occupied ${counts.occupied} + vacant ${counts.vacant} != housing_units ${counts.housing_units} (LOGRECNO ${fields[SEG_LOGRECNO]})`
		)
	}

	return counts
}

/**
 * The eight P2 categories that partition the total (P0020001), in `pl_block` column order.
 */
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
	/**
	 * Two-digit state FIPS, e.g. `"06"`.
	 */
	stateFIPS: string
	/**
	 * Decennial vintage. Default 2020 (the only P.L. 94-171 release this parses).
	 */
	vintage?: number
	/**
	 * Output SQLite path. Default `<dataRoot>/tiger/tiger.db` (same DB as `fetchTIGER`).
	 */
	outPath?: string
	/**
	 * Download cache + default output root.
	 */
	dataRoot?: string
	/**
	 * Optional three-digit county FIPS filter, e.g. `"059"`.
	 */
	county?: string
	/**
	 * Rows per insert. Default 2000.
	 */
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

// Pipe-delimited, fixed field-offset census rows — the manual `split("|")` at each call site stays (the
// parse indexes by position, not by header). spliterator keeps CRLF's trailing CR where readline stripped
// it, but every field this parser reads (geo GEOCODE/LOGRECNO ≤ 9, segment-1 LOGRECNO + P2 ≤ 86) sits well
// before the final column, so the retained CR only ever lands on an unread trailing field.
async function eachLine(path: string, fn: (line: string) => void): Promise<void> {
	for await (const line of TextSpliterator.fromAsync(path)) {
		if (line) {
			fn(line)
		}
	}
}

/**
 * Fetch one state's P.L. 94-171 block race counts into `pl_block`. Yields progress; returns the tally.
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
	const dirName = stateName.replaceAll(" ", "_")
	const fileAbbr = abbr.toLowerCase()

	const cacheDir = join(dataRoot, "census", "redistricting", String(vintage), state)
	// Same stable `tiger.db` default as fetchTIGER — pl_block lives alongside tabblock20 in one DB.
	const outPath = options.outPath ?? join(dataRoot, "tiger", "tiger.db")
	await makeDirectories(cacheDir)
	await makeDirectories(dirname(outPath))

	const zipName = `${fileAbbr}${vintage}.pl.zip`
	const zipPath = join(cacheDir, zipName)
	const url = `${REDISTRICTING_BASE}/${dirName}/${zipName}`

	const cached = await downloadIfNeeded(url, zipPath)
	yield { phase: "download", file: zipName, cached }

	await extractZipEntries(zipPath, cacheDir)
	const geoPath = join(cacheDir, `${fileAbbr}geo${vintage}.pl`)
	const seg1Path = join(cacheDir, `${fileAbbr}00001${vintage}.pl`)
	const seg2Path = join(cacheDir, `${fileAbbr}00002${vintage}.pl`)
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

	// Pass 1b: segment 2 → H1 housing counts for the mapped LOGRECNOs. Read before segment 1 so a block's P2 and H1
	// land in one row; a mapped block with no segment-2 row is a data defect the load refuses, never a zero.
	const h1ByLogrecno = new Map<string, H1Counts>()

	await eachLine(seg2Path, (line) => {
		const f = line.split("|")
		const logrecno = f[SEG_LOGRECNO] ?? ""

		if (!logToGeoid.has(logrecno)) return

		h1ByLogrecno.set(logrecno, parseH1(f))
	})

	yield { phase: "extract", file: `${fileAbbr}00002${vintage}.pl` }

	const kdb = new DatabaseClient<TIGERDatabase>(outPath)
	kdb.exec(TIGER_PRAGMAS)
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
		for await (const line of TextSpliterator.fromAsync(seg1Path)) {
			if (!line) continue
			const f = line.split("|")
			const logrecno = f[SEG_LOGRECNO] ?? ""
			const geoid = logToGeoid.get(logrecno)

			if (!geoid) continue

			const h1 = h1ByLogrecno.get(logrecno)

			if (!h1) {
				throw new Error(`block ${geoid} (LOGRECNO ${logrecno}) has a segment-1 row and no segment-2 row`)
			}

			batch.push({
				GEOID: geoid,
				...h1,
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
		kdb.exec("PRAGMA wal_checkpoint(TRUNCATE);")

		return { outPath, table: "pl_block", inserted }
	} finally {
		await kdb.destroy()
	}
}
