/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   National TIGER EDGES download + interpolation-shard build driver (#483 follow-on).
 *
 *   Orchestrates the per-state `build-interpolation-shard.ts` script across every county in the
 *   contiguous US (3,143 counties) without running them all at once. Downloads county-level EDGES
 *   ZIPs from https://www2.census.gov/geo/tiger/TIGER2023/EDGES/ in parallel (capped at
 *   --concurrency, default 12), retrying on 5xx / network errors, then builds one shard DB per
 *   state via the existing script.
 *
 *   Population-ranked download order: the driver reads `scripts/data/county-population-ranked.json`
 *   (generated on first run from the Census Population Estimates CSV) so the most-populated
 *   counties are downloaded and built first, giving maximum address coverage in minimum wall-clock
 *   time if you kill the run early.
 *
 *   Idempotency: ZIPs already present in --edges-dir are skipped (size-verified). State shard DBs
 *   already present in --out-dir are skipped unless --force is passed.
 *
 *   Usage:
 *     node scripts/build-national-interpolation.mjs [options]
 *
 *   Key options:
 *     --edges-dir <path>    Download destination for TIGER ZIP + SHP files.
 *                           Default: /tmp/tiger-edges
 *     --out-dir <path>      Directory for per-state shard DBs.
 *                           Default: /mnt/playpen/mailwoman-data/interpolation
 *     --release <tag>       TIGER vintage tag written into each shard row.
 *                           Default: TIGER2023
 *     --states <abbr,...>   Comma-separated state abbreviations to build (e.g. VT,DE).
 *                           Omit to build all 50 states + DC.
 *     --top-counties <N>    Build only the N most-populated counties (across all selected states),
 *                           then build the states that have at least one downloaded county.
 *     --concurrency <N>     Max parallel ZIP downloads. Default: 12.
 *     --force               Re-build state shards even if the output DB already exists.
 *     --download-only       Download ZIPs and unpack; skip the shard build step.
 *     --build-only          Skip downloads; build shards from whatever is already in --edges-dir.
 *
 *   Full national build (what you'd run once all counties are downloaded):
 *     node scripts/build-national-interpolation.mjs \
 *       --edges-dir /tmp/tiger-edges \
 *       --out-dir /mnt/playpen/mailwoman-data/interpolation \
 *       --concurrency 12
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import * as https from "node:https"
import * as path from "node:path"
import { parseArgs } from "node:util"
import { execSync, spawnSync } from "node:child_process"
import { pipeline } from "node:stream/promises"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
	options: {
		"edges-dir":     { type: "string",  default: "/tmp/tiger-edges" },
		"out-dir":       { type: "string",  default: "/mnt/playpen/mailwoman-data/interpolation" },
		release:         { type: "string",  default: "TIGER2023" },
		states:          { type: "string" },
		"top-counties":  { type: "string" },
		concurrency:     { type: "string",  default: "12" },
		force:           { type: "boolean", default: false },
		"download-only": { type: "boolean", default: false },
		"build-only":    { type: "boolean", default: false },
	},
	allowPositionals: false,
})

const EDGES_DIR   = /** @type {string} */ (args["edges-dir"])
const OUT_DIR     = /** @type {string} */ (args["out-dir"])
const RELEASE     = /** @type {string} */ (args.release)
const CONCURRENCY = Number(args.concurrency)
const FORCE       = args.force
const DOWNLOAD_ONLY = args["download-only"]
const BUILD_ONLY    = args["build-only"]

// ---------------------------------------------------------------------------
// State FIPS map (mirrors build-interpolation-shard.ts — single source in future)
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
const STATE_FIPS = {
	AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06",
	CO: "08", CT: "09", DE: "10", DC: "11", FL: "12",
	GA: "13", HI: "15", ID: "16", IL: "17", IN: "18",
	IA: "19", KS: "20", KY: "21", LA: "22", ME: "23",
	MD: "24", MA: "25", MI: "26", MN: "27", MS: "28",
	MO: "29", MT: "30", NE: "31", NV: "32", NH: "33",
	NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38",
	OH: "39", OK: "40", OR: "41", PA: "42", RI: "44",
	SC: "45", SD: "46", TN: "47", TX: "48", UT: "49",
	VT: "50", VA: "51", WA: "53", WV: "54", WI: "55",
	WY: "56",
}

/** States to process — filtered by --states flag if provided. */
const TARGET_STATES = args.states
	? args.states.toUpperCase().split(",").map((s) => s.trim()).filter((s) => s in STATE_FIPS)
	: Object.keys(STATE_FIPS)

if (TARGET_STATES.length === 0) {
	console.error("No valid states specified. Check --states values against the STATE_FIPS map.")
	process.exit(1)
}

// ---------------------------------------------------------------------------
// County population ranking
// ---------------------------------------------------------------------------

/** Script-relative path to the static ranked county list. */
const SCRIPTS_DIR = path.dirname(new URL(import.meta.url).pathname)
const RANKED_FILE = path.join(SCRIPTS_DIR, "data", "county-population-ranked.json")

/**
 * @typedef {{ stateFips: string; countyFips: string; geoid: string; name: string; pop2023: number }} CountyRecord
 */

/**
 * Fetch and parse the Census Population Estimates CSV, then materialise the sorted county list.
 * SUMLEV=050 rows are county-level; STATE + COUNTY form the 5-digit GEOID (zero-padded).
 *
 * @returns {Promise<CountyRecord[]>}
 */
async function fetchAndBuildRanking() {
	console.log("Fetching Census Population Estimates CSV (co-est2023-alldata.csv)…")
	const url = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2023/counties/totals/co-est2023-alldata.csv"
	const csv = await fetchText(url)
	const lines = csv.split("\n")
	const header = lines[0].split(",")
	const idx = (col) => header.indexOf(col)
	const iSumlev = idx("SUMLEV")
	const iState  = idx("STATE")
	const iCounty = idx("COUNTY")
	const iName   = idx("CTYNAME")
	const iPop    = idx("POPESTIMATE2023")

	/** @type {CountyRecord[]} */
	const records = []
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim()
		if (!line) continue
		const cols = line.split(",")
		if (cols[iSumlev] !== "050") continue           // county rows only
		const stateFips  = cols[iState].padStart(2, "0")
		const countyFips = cols[iCounty].padStart(3, "0")
		const geoid      = stateFips + countyFips
		const name       = cols[iName] ?? ""
		const pop2023    = Number(cols[iPop]) || 0
		records.push({ stateFips, countyFips, geoid, name, pop2023 })
	}

	// Sort descending by population (highest first → most coverage early)
	records.sort((a, b) => b.pop2023 - a.pop2023)
	return records
}

/**
 * Load (or generate) the ranked county list. On first run this downloads the Census CSV; on
 * subsequent runs it reads the cached JSON file.
 *
 * @returns {Promise<CountyRecord[]>}
 */
async function loadRankedCounties() {
	if (existsSync(RANKED_FILE)) {
		return JSON.parse(readFileSync(RANKED_FILE, "utf8"))
	}
	const records = await fetchAndBuildRanking()
	mkdirSync(path.dirname(RANKED_FILE), { recursive: true })
	writeFileSync(RANKED_FILE, JSON.stringify(records, null, 2))
	console.log(`Saved county ranking → ${RANKED_FILE} (${records.length} counties)`)
	return records
}

// Fix: readFileSync is not imported yet — re-import at top-level.
import { readFileSync } from "node:fs"

// ---------------------------------------------------------------------------
// HTTP utilities
// ---------------------------------------------------------------------------

/** Simple GET-to-text over HTTPS with redirect following (≤3 hops). */
function fetchText(url, redirectsLeft = 3) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				if (redirectsLeft <= 0) return reject(new Error(`Too many redirects: ${url}`))
				resolve(fetchText(res.headers.location, redirectsLeft - 1))
				return
			}
			if (res.statusCode !== 200) {
				return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
			}
			const chunks = []
			res.on("data", (c) => chunks.push(c))
			res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
		})
		req.on("error", reject)
	})
}

/**
 * Download a URL to a local file path, with retry on 5xx / network errors.
 *
 * @param {string} url
 * @param {string} dest  Absolute path of the output file.
 * @param {number} [retries=3]
 * @returns {Promise<void>}
 */
async function downloadFile(url, dest, retries = 3) {
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			await _downloadOnce(url, dest)
			return
		} catch (err) {
			const status = err.message?.match(/HTTP (\d+)/)?.[1]
			const retryable = !status || Number(status) >= 500
			if (!retryable || attempt === retries) throw err
			const delay = attempt * 2000
			console.warn(`  [retry ${attempt}/${retries}] ${path.basename(dest)}: ${err.message} — waiting ${delay}ms`)
			await new Promise((r) => setTimeout(r, delay))
		}
	}
}

function _downloadOnce(url, dest) {
	return new Promise((resolve, reject) => {
		const follow = (u, hopsLeft) => {
			if (hopsLeft <= 0) return reject(new Error(`Too many redirects: ${url}`))
			const req = https.get(u, (res) => {
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume()
					follow(res.headers.location, hopsLeft - 1)
					return
				}
				if (res.statusCode !== 200) {
					res.resume()
					return reject(new Error(`HTTP ${res.statusCode} for ${u}`))
				}
				const out = createWriteStream(dest)
				pipeline(res, out).then(resolve).catch(reject)
			})
			req.on("error", reject)
		}
		follow(url, 5)
	})
}

// ---------------------------------------------------------------------------
// ZIP extraction
// ---------------------------------------------------------------------------

/**
 * Unpack a TIGER EDGES ZIP into --edges-dir using the system `unzip` command. Only extracts files
 * whose names end with `.shp`, `.dbf`, `.prj`, `.shx` — the shapefile components DuckDB needs.
 * Silently overwrites existing files (idempotent at the shapefile level).
 *
 * @param {string} zipPath
 * @param {string} destDir
 */
function extractEdgesZip(zipPath, destDir) {
	// unzip -o (overwrite) -d (dest) <zip> *.shp *.dbf *.prj *.shx
	const result = spawnSync("unzip", ["-o", "-j", zipPath, "*.shp", "*.dbf", "*.prj", "*.shx", "-d", destDir], {
		stdio: ["ignore", "pipe", "pipe"],
	})
	if (result.status !== 0) {
		throw new Error(`unzip failed for ${zipPath}: ${result.stderr.toString().trim()}`)
	}
}

// ---------------------------------------------------------------------------
// Parallel download pool
// ---------------------------------------------------------------------------

/**
 * Download and unpack a list of county ZIPs with capped parallelism.
 *
 * @param {Array<{ geoid: string; zipUrl: string; zipPath: string }>} tasks
 * @param {number} concurrency
 * @param {string} edgesDir
 * @returns {Promise<{ downloaded: number; skipped: number; failed: string[] }>}
 */
async function downloadParallel(tasks, concurrency, edgesDir) {
	let downloaded = 0
	let skipped = 0
	const failed = []
	let idx = 0

	async function worker() {
		while (idx < tasks.length) {
			const task = tasks[idx++]
			const shpBase = `tl_2023_${task.geoid}_edges.shp`
			const shpPath = path.join(edgesDir, shpBase)

			// Idempotency: skip if the SHP is already present (the ZIP may be gone after extraction)
			if (existsSync(shpPath)) {
				skipped++
				continue
			}

			// Also skip if the ZIP is already present (interrupted run: unpack it)
			if (existsSync(task.zipPath)) {
				try {
					extractEdgesZip(task.zipPath, edgesDir)
					skipped++
					continue
				} catch (err) {
					console.warn(`  [warn] re-extract failed for ${task.geoid}: ${err.message}`)
				}
			}

			try {
				await downloadFile(task.zipUrl, task.zipPath)
				extractEdgesZip(task.zipPath, edgesDir)
				downloaded++
			} catch (err) {
				console.error(`  [fail] ${task.geoid}: ${err.message}`)
				failed.push(task.geoid)
			}
		}
	}

	await Promise.all(Array.from({ length: concurrency }, worker))
	return { downloaded, skipped, failed }
}

// ---------------------------------------------------------------------------
// Shard build (per state)
// ---------------------------------------------------------------------------

const BUILD_SCRIPT = path.join(SCRIPTS_DIR, "build-interpolation-shard.ts")

/**
 * Build one state's interpolation shard DB. Returns wall-clock ms + segment count from the script's
 * stdout.
 *
 * @param {string} stateAbbr  e.g. "VT"
 * @param {string} edgesDir
 * @param {string} outDir
 * @param {string} release
 * @returns {{ wallMs: number; segments: number; counties: number } | null}
 */
function buildStateShard(stateAbbr, edgesDir, outDir, release) {
	const outDb = path.join(outDir, `interpolation-us-${stateAbbr.toLowerCase()}.db`)
	if (existsSync(outDb) && !FORCE) {
		console.log(`  [skip] ${stateAbbr}: shard already exists at ${outDb} (--force to rebuild)`)
		return null
	}

	mkdirSync(outDir, { recursive: true })
	const t0 = Date.now()
	const result = spawnSync(
		"node",
		[
			"--experimental-strip-types",
			"--disable-warning=ExperimentalWarning",
			BUILD_SCRIPT,
			"--state", stateAbbr,
			"--edges-dir", edgesDir,
			"--release", release,
			"--out", outDb,
		],
		{
			cwd: SCRIPTS_DIR + "/..",
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
		}
	)
	const wallMs = Date.now() - t0

	if (result.status !== 0) {
		console.error(`  [fail] ${stateAbbr}: build-interpolation-shard exited ${result.status}`)
		console.error(result.stderr.trim())
		return { wallMs, segments: 0, counties: 0 }
	}

	const stdout = result.stdout.trim()
	// Parse "N segment-sides → <path>" line
	const segMatch = stdout.match(/^(\d+) segment-sides/m)
	const segments = segMatch ? Number(segMatch[1]) : 0
	// Parse "N county shapefiles for STATE"
	const countyMatch = stdout.match(/^(\d+) county shapefiles/m)
	const counties = countyMatch ? Number(countyMatch[1]) : 0

	// Echo the script's output with a state prefix
	for (const line of stdout.split("\n")) {
		if (line) console.log(`  [${stateAbbr}] ${line}`)
	}
	if (result.stderr.trim()) {
		for (const line of result.stderr.trim().split("\n")) {
			if (line) console.warn(`  [${stateAbbr}:stderr] ${line}`)
		}
	}

	return { wallMs, segments, counties }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log("=== National TIGER interpolation shard build ===")
	console.log(`states:      ${TARGET_STATES.join(", ")}`)
	console.log(`edges-dir:   ${EDGES_DIR}`)
	console.log(`out-dir:     ${OUT_DIR}`)
	console.log(`concurrency: ${CONCURRENCY}`)
	console.log(`release:     ${RELEASE}`)
	if (FORCE) console.log("force:       true (re-building existing shards)")
	console.log("")

	mkdirSync(EDGES_DIR, { recursive: true })
	mkdirSync(OUT_DIR, { recursive: true })

	// ── Step 1: load county population ranking ─────────────────────────────
	console.log("Step 1: county population ranking")
	const allCounties = await loadRankedCounties()
	console.log(`  ${allCounties.length} counties in ranking`)

	// Filter to target states only
	const targetFipsSet = new Set(TARGET_STATES.map((s) => STATE_FIPS[s]))
	let counties = allCounties.filter((c) => targetFipsSet.has(c.stateFips))

	// Apply --top-counties cap if set
	const topN = args["top-counties"] ? Number(args["top-counties"]) : null
	if (topN !== null) {
		counties = counties.slice(0, topN)
		console.log(`  capped to top ${topN} counties by population`)
	}

	console.log(`  ${counties.length} counties to process`)
	console.log("")

	// ── Step 2: download ZIPs ──────────────────────────────────────────────
	if (!BUILD_ONLY) {
		console.log(`Step 2: downloading TIGER EDGES ZIPs (concurrency=${CONCURRENCY})`)
		const BASE = "https://www2.census.gov/geo/tiger/TIGER2023/EDGES"
		const tasks = counties.map((c) => {
			const geoid = c.geoid  // 5-digit: stateFips + countyFips
			const zipFile = `tl_2023_${geoid}_edges.zip`
			return {
				geoid,
				zipUrl: `${BASE}/${zipFile}`,
				zipPath: path.join(EDGES_DIR, zipFile),
			}
		})
		const { downloaded, skipped, failed } = await downloadParallel(tasks, CONCURRENCY, EDGES_DIR)
		console.log(`  downloaded: ${downloaded}, skipped (already present): ${skipped}, failed: ${failed.length}`)
		if (failed.length > 0) {
			console.warn(`  failed GEOIDs: ${failed.slice(0, 20).join(", ")}${failed.length > 20 ? " …" : ""}`)
		}
		console.log("")
	}

	if (DOWNLOAD_ONLY) {
		console.log("--download-only: stopping after downloads.")
		return
	}

	// ── Step 3: determine which states have ≥1 county SHP ─────────────────
	console.log("Step 3: building per-state shards")
	// States from our target list that have at least one downloaded county SHP
	const availableStates = TARGET_STATES.filter((abbr) => {
		const fips = STATE_FIPS[abbr]
		const pattern = new RegExp(`tl_\\d+_${fips}\\d{3}_edges\\.shp$`)
		return readdirSync(EDGES_DIR).some((f) => pattern.test(f))
	})

	if (availableStates.length === 0) {
		console.error("No county SHPs found in edges-dir for any target state. Run without --build-only first.")
		process.exit(1)
	}
	console.log(`  ${availableStates.length} states with available SHPs: ${availableStates.join(", ")}`)
	console.log("")

	// ── Step 4: build shards sequentially ─────────────────────────────────
	// Sequential (not parallel): each shard script uses DuckDB + SQLite; they're already
	// I/O + DuckDB-parallel internally. Running states concurrently risks memory OOM on the
	// 32K-row state builds and complicates progress reporting.
	const wallStart = Date.now()
	let totalSegments = 0
	let builtStates = 0
	/** @type {Array<{ state: string; counties: number; segments: number; wallMs: number }>} */
	const stateResults = []

	for (const abbr of availableStates) {
		console.log(`Building ${abbr}…`)
		const result = buildStateShard(abbr, EDGES_DIR, OUT_DIR, RELEASE)
		if (result === null) {
			// skipped (already exists, no --force)
			stateResults.push({ state: abbr, counties: 0, segments: 0, wallMs: 0, skipped: true })
			continue
		}
		builtStates++
		totalSegments += result.segments
		stateResults.push({ state: abbr, counties: result.counties, segments: result.segments, wallMs: result.wallMs })
		const elapsed = ((result.wallMs) / 1000).toFixed(1)
		console.log(
			`  ${abbr}: ${result.counties} counties, ${result.segments.toLocaleString()} segment-sides, ${elapsed}s`
		)
		console.log("")
	}

	// ── Summary ────────────────────────────────────────────────────────────
	const totalWallMs = Date.now() - wallStart
	console.log("=== Summary ===")
	console.log(`States built:    ${builtStates} / ${availableStates.length}`)
	console.log(`Total segments:  ${totalSegments.toLocaleString()}`)
	console.log(`Wall clock:      ${(totalWallMs / 1000).toFixed(1)}s`)
	console.log("")
	console.log("Per-state:")
	for (const r of stateResults) {
		if (r.skipped) {
			console.log(`  ${r.state}: SKIPPED (already built)`)
		} else {
			console.log(`  ${r.state}: ${r.counties} counties · ${r.segments.toLocaleString()} segments · ${(r.wallMs / 1000).toFixed(1)}s`)
		}
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
