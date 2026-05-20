#!/usr/bin/env npx tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a TIGER/Line SQLite database from Census Bureau ADDRFEAT + PLACE shapefiles.
 *
 *   Replaces the multi-step `fetch-tiger-full.sh` + manual ogr2ogr dance with a single idempotent
 *   TypeScript pipeline. Pattern ported from isp-nexus's `sync/scripts/generate-tiger-tiles.ts`.
 *
 *   ## What it does
 *
 *   1. Fetches the Census Bureau's TIGER 2024 ADDRFEAT directory listing to discover all county ZIP
 *        filenames.
 *   2. Downloads each county's ADDRFEAT ZIP (skipping already-cached files whose sha256 matches the
 *        per-state MANIFEST).
 *   3. Extracts shapefiles from the downloaded ZIPs (idempotent — skips already-extracted).
 *   4. Runs `ogr2ogr -f SQLite` to build `tiger_streets` (per-county ADDRFEAT append) and `tiger_places`
 *        (per-state PLACE) tables.
 *   5. Builds indexes on `statefp` and `linearid`.
 *
 *   ## Usage
 *
 *   ```sh
 *   OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
 *   npx tsx packages/corpus/scripts/build-tiger-db.ts
 * ```
 *
 *   Env vars: OUT_ROOT — destination root (default: ./data/corpus/sources) TIGER_YEAR — TIGER vintage
 *   (default: 2024) SKIP_DOWNLOAD — set to 1 to skip download step (assumes ZIPs already on disk)
 *   SKIP_EXTRACT — set to 1 to skip extraction step MAX_PARALLEL — max concurrent downloads
 *   (default: 8)
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { rename, rm } from "node:fs/promises"
import { get } from "node:https"
import { basename, join } from "node:path"
import { createFileWritableStream } from "spliterator/node/fs"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OUT_ROOT = process.env.OUT_ROOT ?? join(process.cwd(), "data", "corpus", "sources")
const TIGER_YEAR = process.env.TIGER_YEAR ?? "2024"
const SKIP_DOWNLOAD = process.env.SKIP_DOWNLOAD === "1"
const SKIP_EXTRACT = process.env.SKIP_EXTRACT === "1"
// const MAX_PARALLEL = parseInt(process.env.MAX_PARALLEL ?? "8", 10)
const MAX_PARALLEL = parseInt(process.env.MAX_PARALLEL ?? "2", 10)

const BASE_URL = `https://www2.census.gov/geo/tiger/TIGER${TIGER_YEAR}`
const ADDRFEAT_DIR = join(OUT_ROOT, "tiger", "addrfeat")
const EXTRACTED_DIR = join(OUT_ROOT, "tiger", "extracted")
const DB_PATH = join(OUT_ROOT, "tiger", "tiger.db")

// All US states + DC + territories that have TIGER data
const STATE_FIPS_CODES: string[] = [
	"01",
	"02",
	"04",
	"05",
	"06",
	"08",
	"09",
	"10",
	"11",
	"12",
	"13",
	"15",
	"16",
	"17",
	"18",
	"19",
	"20",
	"21",
	"22",
	"23",
	"24",
	"25",
	"26",
	"27",
	"28",
	"29",
	"30",
	"31",
	"32",
	"33",
	"34",
	"35",
	"36",
	"37",
	"38",
	"39",
	"40",
	"41",
	"42",
	"44",
	"45",
	"46",
	"47",
	"48",
	"49",
	"50",
	"51",
	"53",
	"54",
	"55",
	"56",
	"60",
	"66",
	"69",
	"72",
	"78",
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
	process.stderr.write(`  ${msg}\n`)
}

function sha256File(path: string): string {
	const h = createHash("sha256")
	h.update(readFileSync(path))
	return h.digest("hex")
}

function verifyZip(path: string): boolean {
	try {
		execFileSync("unzip", ["-tq", path], { stdio: "pipe" })
		return true
	} catch {
		return false
	}
}

async function httpGet(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		get(url, { timeout: 30000 }, (res) => {
			if (res.statusCode === 301 || res.statusCode === 302) {
				const loc = res.headers.location
				if (loc) return resolve(httpGet(loc))
				return reject(new Error(`redirect without location for ${url}`))
			}
			if (res.statusCode !== 200) {
				return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
			}
			const chunks: Buffer[] = []
			res.on("data", (c: Buffer) => chunks.push(c))
			res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
			res.on("error", reject)
		}).on("error", reject)
	})
}

async function downloadFile(url: string, dest: string, retries = 3): Promise<void> {
	const tmp = dest + ".tmp"

	for (let attempt = 0; attempt < retries; attempt++) {
		if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 3000 * attempt))

		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(600_000) })
			if (res.status === 301 || res.status === 302) {
				const loc = res.headers.get("location")
				if (loc) return downloadFile(loc, dest, 1)
				throw new Error(`redirect without location for ${url}`)
			}
			if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
			if (!res.body) throw new Error(`No response body for ${url}`)

			const fileStream = await createFileWritableStream(tmp)
			await res.body.pipeTo(fileStream)
		} catch (err) {
			log(`  Download error: ${err} — retrying`)
			try {
				unlinkSync(tmp)
			} catch {
				/* empty */
			}
			continue
		}

		if (!existsSync(tmp)) continue
		if (!verifyZip(tmp)) {
			const size = statSync(tmp).size
			log(`  Corrupt download ${url} (${size} bytes) — retrying (${attempt + 1}/${retries})`)
			unlinkSync(tmp)
			continue
		}
		try {
			await rename(tmp, dest)
		} catch (err: unknown) {
			if (existsSync(dest)) {
				try {
					unlinkSync(tmp)
				} catch {
					/* empty */
				}
				return
			}
			throw err
		}
		return
	}
}

// ---------------------------------------------------------------------------
// Step 1: Discover county ZIP filenames from the Census directory listing
// ---------------------------------------------------------------------------

interface CountyFile {
	filename: string
	statefp: string
	countyfp: string
	url: string
}

async function discoverCountyFiles(): Promise<CountyFile[]> {
	log("Discovering TIGER ADDRFEAT county files from Census directory listing...")

	const html = await httpGet(`${BASE_URL}/ADDRFEAT/`)

	// Parse the Apache directory listing for ZIP filenames.
	// Pattern: <a href="tl_2024_SSCCC_addrfeat.zip">
	const re = new RegExp(`tl_${TIGER_YEAR}_(\\d{2})(\\d{3})_addrfeat\\.zip`, "gi")
	const files: CountyFile[] = []
	let m: RegExpExecArray | null
	while ((m = re.exec(html)) !== null) {
		files.push({
			filename: m[0],
			statefp: m[1]!,
			countyfp: m[2]!,
			url: `${BASE_URL}/ADDRFEAT/${m[0]}`,
		})
	}

	log(`Found ${files.length} county ADDRFEAT files across ${new Set(files.map((f) => f.statefp)).size} states`)

	// Filter to only states we care about, deduplicate by filename+statefp
	const seen = new Set<string>()
	const filtered: CountyFile[] = []
	for (const f of files) {
		if (!STATE_FIPS_CODES.includes(f.statefp)) continue
		const key = `${f.statefp}/${f.filename}`
		if (seen.has(key)) continue
		seen.add(key)
		filtered.push(f)
	}
	const dupes = files.length - seen.size
	if (dupes > 0) log(`  → deduped ${dupes} duplicate entries`)
	log(`  → ${filtered.length} files for ${new Set(filtered.map((f) => f.statefp)).size} target states`)
	return filtered
}

// ---------------------------------------------------------------------------
// Step 2: Download missing ZIPs (idempotent via per-state MANIFEST)
// ---------------------------------------------------------------------------

async function ensureZipDownloaded(
	f: CountyFile,
	_concurrency: number,
	total: number,
	index: number
): Promise<boolean> {
	const stateDir = join(ADDRFEAT_DIR, `state-${f.statefp}`)
	mkdirSync(stateDir, { recursive: true })
	const dest = join(stateDir, f.filename)
	const manifestPath = join(stateDir, "MANIFEST.json")

	// Check if already downloaded with valid sha256 in manifest
	if (existsSync(dest)) {
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
			const counties = manifest.counties ?? []
			const entry = counties.find((c: { filename: string }) => c.filename === f.filename)
			if (entry?.sha256) {
				const actual = sha256File(dest)
				if (actual === entry.sha256 && verifyZip(dest)) {
					return false // already valid
				}
				// sha256 matches but ZIP is corrupt — re-download
				if (actual === entry.sha256 && !verifyZip(dest)) {
					log(`  Corrupt ZIP detected: ${f.filename} — re-downloading`)
					unlinkSync(dest)
				}
			}
		} catch {
			// manifest missing or corrupt — re-download
		}
	}

	if ((index + 1) % 50 === 0 || index === 0) log(`[${index + 1}/${total}] Downloading...`)
	await downloadFile(f.url, dest)

	// downloadFile may give up and not create the file — skip manifest update
	if (!existsSync(dest)) return false

	// Update manifest
	const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { counties: [] }
	const sha = sha256File(dest)
	const bytes = statSync(dest).size

	const existing = manifest.counties.findIndex((c: { filename: string }) => c.filename === f.filename)
	if (existing >= 0) {
		manifest.counties[existing] = { filename: f.filename, sha256: sha, bytes }
	} else {
		manifest.counties.push({ filename: f.filename, sha256: sha, bytes })
	}
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
	return true
}

interface PlaceFile {
	filename: string
	statefp: string
	url: string
}

async function discoverPlaceFiles(): Promise<PlaceFile[]> {
	log("Discovering TIGER PLACE files from Census directory listing...")
	const html = await httpGet(`${BASE_URL}/PLACE/`)
	const re = new RegExp(`tl_${TIGER_YEAR}_(\\d{2})_place\\.zip`, "gi")
	const seen = new Set<string>()
	const files: PlaceFile[] = []
	let m: RegExpExecArray | null
	while ((m = re.exec(html)) !== null) {
		const statefp = m[1]!
		if (!STATE_FIPS_CODES.includes(statefp)) continue
		if (seen.has(statefp)) continue
		seen.add(statefp)
		files.push({
			filename: m[0],
			statefp,
			url: `${BASE_URL}/PLACE/${m[0]}`,
		})
	}
	log(`  -> ${files.length} PLACE files for target states`)
	return files
}

async function downloadAll(countyFiles: CountyFile[]): Promise<void> {
	if (SKIP_DOWNLOAD) {
		log("SKIP_DOWNLOAD=1 — skipping download step")
		return
	}

	mkdirSync(ADDRFEAT_DIR, { recursive: true })
	const total = countyFiles.length
	let downloaded = 0
	let skipped = 0

	// Process in batches for concurrency
	for (let i = 0; i < total; i += MAX_PARALLEL) {
		const batch = countyFiles.slice(i, i + MAX_PARALLEL)
		const results = await Promise.all(batch.map((f, bi) => ensureZipDownloaded(f, MAX_PARALLEL, total, i + bi)))
		downloaded += results.filter(Boolean).length
		skipped += results.filter((r) => !r).length
	}

	log(`ADDRFEAT complete: ${downloaded} downloaded, ${skipped} already current`)

	// Also download PLACE files (per-state, not per-county)
	const placeFiles = await discoverPlaceFiles()
	log(`Downloading ${placeFiles.length} PLACE files...`)
	let placeDownloaded = 0
	for (const pf of placeFiles) {
		const stateDir = join(ADDRFEAT_DIR, `state-${pf.statefp}`)
		mkdirSync(stateDir, { recursive: true })
		const dest = join(stateDir, pf.filename)
		const already = existsSync(dest) && verifyZip(dest)
		if (!already) {
			log(`  Downloading ${pf.filename}...`)
			await downloadFile(pf.url, dest)
			placeDownloaded++
		}
	}
	log(`PLACE complete: ${placeDownloaded} downloaded, ${placeFiles.length - placeDownloaded} already current`)
}

// ---------------------------------------------------------------------------
// Step 3: Extract shapefiles from ZIPs
// ---------------------------------------------------------------------------

async function extractZip(zipPath: string, destDir: string): Promise<void> {
	// Use system unzip — idempotent: skip if files already exist
	const { execSync } = await import("node:child_process")
	execSync(`unzip -n -q "${zipPath}" -d "${destDir}"`, { stdio: "pipe" })
}

async function extractAll(): Promise<string[]> {
	if (SKIP_EXTRACT) {
		log("SKIP_EXTRACT=1 — skipping extraction step")
		return readdirSync(EXTRACTED_DIR, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
	}

	mkdirSync(EXTRACTED_DIR, { recursive: true })
	const stateDirs = readdirSync(ADDRFEAT_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory() && d.name.startsWith("state-"))
		.map((d) => d.name)

	const processedStates: string[] = []

	for (const stateDir of stateDirs) {
		const stateFips = stateDir.replace("state-", "")
		const extractStateDir = join(EXTRACTED_DIR, stateFips)
		mkdirSync(extractStateDir, { recursive: true })

		const zipFiles = readdirSync(join(ADDRFEAT_DIR, stateDir)).filter((f) => f.endsWith(".zip"))

		let extracted = 0
		for (const zip of zipFiles) {
			const zipPath = join(ADDRFEAT_DIR, stateDir, zip)
			try {
				await extractZip(zipPath, extractStateDir)
				extracted++
			} catch (_err) {
				log(`  ✗ Failed to extract ${zip}: corrupt or incomplete — delete and re-run`)
				try {
					unlinkSync(zipPath)
				} catch {
					/* empty */
				}
			}
		}
		if (extracted > 0) log(`Extracted ${extracted} zips for state ${stateFips}`)
		processedStates.push(stateFips)
	}

	return processedStates
}

// ---------------------------------------------------------------------------
// Step 4: Build SQLite DB via ogr2ogr
// ---------------------------------------------------------------------------

function runOgr2Ogr(args: string[]): void {
	try {
		execFileSync("ogr2ogr", args, { stdio: "inherit" })
	} catch (err) {
		process.stderr.write(`ogr2ogr failed: ${err}\n`)
		process.exit(1)
	}
}

async function buildDatabase(stateFipsList: string[]): Promise<void> {
	// Remove existing DB
	if (existsSync(DB_PATH)) {
		await rm(DB_PATH, { force: true })
	}

	log(`Building TIGER SQLite database at ${DB_PATH}...`)

	let firstStreet = true
	let firstPlace = true

	for (const statefp of stateFipsList) {
		const extractDir = join(EXTRACTED_DIR, statefp)
		if (!existsSync(extractDir)) {
			log(`  No extracted data for state ${statefp} — skipping`)
			continue
		}
		const shpFiles = readdirSync(extractDir).filter(
			(f) => f.endsWith(".shp") && f.startsWith(`tl_${TIGER_YEAR}_${statefp}`)
		)

		const addrfeatShps = shpFiles.filter((f) => f.includes("_addrfeat"))
		const placeShps = shpFiles.filter((f) => f.includes("_place"))

		if (addrfeatShps.length > 0) {
			log(`  Building tiger_streets for state ${statefp} (${addrfeatShps.length} counties)...`)

			// Build streets: one ogr2ogr call per county, appending to the table.
			// STATEFP is not a column in ADDRFEAT — derive it from the filename context.
			for (const shp of addrfeatShps) {
				const shpPath = join(extractDir, shp)
				const layer = basename(shp, ".shp")
				const sql = [
					"SELECT",
					"  LINEARID,",
					"  FULLNAME,",
					"  ZIPL,",
					"  ZIPR,",
					`  '${statefp}' AS STATEFP`,
					`FROM '${layer}'`,
					"WHERE FULLNAME IS NOT NULL AND FULLNAME != ''",
				].join(" ")

				const args = [
					"-f",
					"SQLite",
					...(firstStreet ? ["-nln", "tiger_streets"] : ["-update", "-append", "-nln", "tiger_streets"]),
					"-dialect",
					"SQLite",
					"-sql",
					sql,
					DB_PATH,
					shpPath,
				]
				firstStreet = false
				runOgr2Ogr(args)
			}
		}

		if (placeShps.length > 0) {
			log(`  Building tiger_places for state ${statefp}...`)
			const shp = placeShps[0]! // PLACE is per-state, one file
			const shpPath = join(extractDir, shp)
			const layer = basename(shp, ".shp")
			const sql = [
				"SELECT",
				"  GEOID,",
				"  NAME,",
				"  STATEFP,",
				"  LSAD,",
				"  NAMELSAD,",
				"  CLASSFP",
				`FROM '${layer}'`,
			].join(" ")

			const args = [
				"-f",
				"SQLite",
				...(firstPlace ? ["-nln", "tiger_places"] : ["-update", "-append", "-nln", "tiger_places"]),
				"-dialect",
				"SQLite",
				"-sql",
				sql,
				DB_PATH,
				shpPath,
			]
			firstPlace = false
			runOgr2Ogr(args)
		}
	}

	// Build indexes
	log("Building indexes...")
	const { DatabaseSync } = await import("node:sqlite")
	const db = new DatabaseSync(DB_PATH)
	db.exec("PRAGMA journal_mode = WAL")
	db.exec("CREATE INDEX IF NOT EXISTS idx_tiger_streets_statefp ON tiger_streets(statefp)")
	db.exec("CREATE INDEX IF NOT EXISTS idx_tiger_streets_linearid ON tiger_streets(linearid)")
	try {
		db.exec("CREATE INDEX IF NOT EXISTS idx_tiger_places_statefp ON tiger_places(statefp)")
		db.exec("CREATE INDEX IF NOT EXISTS idx_tiger_places_geoid ON tiger_places(geoid)")
	} catch {
		log("  No tiger_places table — skipping place indexes")
	}
	db.close()

	// Write MANIFEST
	const dbSize = statSync(DB_PATH).size
	const dbSha = sha256File(DB_PATH)
	const manifest = {
		built_at: new Date().toISOString(),
		tiger_year: TIGER_YEAR,
		states: stateFipsList,
		sha256: dbSha,
		bytes: dbSize,
		tables: ["tiger_streets", "tiger_places"],
	}
	writeFileSync(DB_PATH.replace(".db", ".manifest.json"), JSON.stringify(manifest, null, 2) + "\n")

	log(`Database built: ${(dbSize / 1024 / 1024).toFixed(0)} MB, sha256=${dbSha.slice(0, 12)}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const start = Date.now()
	process.stderr.write("=== TIGER SQLite build ===\n")

	const countyFiles = await discoverCountyFiles()
	await downloadAll(countyFiles)

	const stateFipsList = [...new Set(countyFiles.map((f) => f.statefp))].sort()
	await extractAll()
	await buildDatabase(stateFipsList)

	const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1)
	process.stderr.write(`=== Done in ${elapsed} min ===\n`)
}

main().catch((err) => {
	process.stderr.write(`Fatal: ${err}\n`)
	process.exit(1)
})
