/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman situs interpolation` — national TIGER EDGES download + interpolation-shard build
 *   driver (#483 follow-on).
 *
 *   Orchestrates the per-state `mailwoman situs interpolation-shard` command across every county in
 *   the contiguous US (3,143 counties) without running them all at once. Downloads county-level
 *   EDGES ZIPs from https://www2.census.gov/geo/tiger/TIGER2023/EDGES/ in parallel (capped at
 *   `--concurrency`, default 12), retrying on 5xx / network errors, then builds one shard DB per
 *   state via that sibling command.
 *
 *   Population-ranked download order: the driver reads `mailwoman/data/county-population-ranked.json`
 *   (generated on first run from the Census Population Estimates CSV) so the most-populated
 *   counties are downloaded and built first, giving maximum address coverage in minimum wall-clock
 *   time if you kill the run early.
 *
 *   Idempotency: ZIPs already present in `--edges-dir` are skipped (size-verified). State shard DBs
 *   already present in `--out-dir` are skipped unless `--force` is passed. The per-state CHILD owns
 *   its own DB's write; this driver only orchestrates downloads + child builds and writes the small
 *   ranked-county cache, so there is no national-DB temp-then-rename here — large-artifact
 *   atomicity lives one level down in the shard builder. Progress streams to stderr; the summary
 *   lands on stdout.
 */

import { spawnSync } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import * as https from "node:https"
import * as path from "node:path"
import { pipeline } from "node:stream/promises"

import { dataRootPath, repoRootPathBuilder } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../sdk/cli.js"

const OptionsSchema = zod.object({
	edgesDir: zod.string().default("/tmp/tiger-edges").describe("Download destination for TIGER ZIP + SHP files"),
	outDir: zod.string().optional().describe("Directory for per-state shard DBs. Default <data-root>/interpolation"),
	release: zod.string().default("TIGER2023").describe("TIGER vintage tag written into each shard row"),
	states: zod
		.string()
		.optional()
		.describe("Comma-separated state abbreviations to build (e.g. VT,DE). Omit to build all 50 states + DC"),
	topCounties: zod.coerce
		.number()
		.int()
		.positive()
		.optional()
		.describe("Build only the N most-populated counties (across all selected states)"),
	concurrency: zod.coerce.number().int().positive().default(12).describe("Max parallel ZIP downloads"),
	force: zod.boolean().default(false).describe("Re-build state shards even if the output DB already exists"),
	downloadOnly: zod.boolean().default(false).describe("Download ZIPs and unpack; skip the shard build step"),
	buildOnly: zod
		.boolean()
		.default(false)
		.describe("Skip downloads; build shards from whatever is already in --edges-dir"),
})

export { OptionsSchema as options }

// ---------------------------------------------------------------------------
// State FIPS map (mirrors build-interpolation-shard.ts — single source in future)
// ---------------------------------------------------------------------------

const STATE_FIPS: Record<string, string> = {
	AL: "01",
	AK: "02",
	AZ: "04",
	AR: "05",
	CA: "06",
	CO: "08",
	CT: "09",
	DE: "10",
	DC: "11",
	FL: "12",
	GA: "13",
	HI: "15",
	ID: "16",
	IL: "17",
	IN: "18",
	IA: "19",
	KS: "20",
	KY: "21",
	LA: "22",
	ME: "23",
	MD: "24",
	MA: "25",
	MI: "26",
	MN: "27",
	MS: "28",
	MO: "29",
	MT: "30",
	NE: "31",
	NV: "32",
	NH: "33",
	NJ: "34",
	NM: "35",
	NY: "36",
	NC: "37",
	ND: "38",
	OH: "39",
	OK: "40",
	OR: "41",
	PA: "42",
	RI: "44",
	SC: "45",
	SD: "46",
	TN: "47",
	TX: "48",
	UT: "49",
	VT: "50",
	VA: "51",
	WA: "53",
	WV: "54",
	WI: "55",
	WY: "56",
}

// Repo-relative anchor for the cached county-population ranking (resolves cleanly in both source +
// compiled trees via the core repo-root builder).
const RANKED_FILE = String(repoRootPathBuilder("mailwoman", "data", "county-population-ranked.json"))

// The per-state STREET-SEGMENT builder is now the sibling `situs interpolation-shard` command (the old
// `scripts/build-interpolation-shard.ts` was migrated into the CLI). Re-invoke the SAME CLI entry this
// process was started from, so dev + published installs both resolve correctly.
const CLI_ENTRY = process.argv[1]!
const ANSI_PATTERN = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g")
const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, "")

// ---------------------------------------------------------------------------
// County population ranking
// ---------------------------------------------------------------------------

type CountyRecord = {
	stateFips: string
	countyFips: string
	geoid: string
	name: string
	pop2023: number
}

/**
 * Fetch and parse the Census Population Estimates CSV, then materialise the sorted county list. SUMLEV=050 rows are
 * county-level; STATE + COUNTY form the 5-digit GEOID (zero-padded).
 */
async function fetchAndBuildRanking(): Promise<CountyRecord[]> {
	console.error("Fetching Census Population Estimates CSV (co-est2023-alldata.csv)…")
	const url =
		"https://www2.census.gov/programs-surveys/popest/datasets/2020-2023/counties/totals/co-est2023-alldata.csv"
	const csv = await fetchText(url)
	const lines = csv.split("\n")
	const header = lines[0]!.split(",")
	const idx = (col: string) => header.indexOf(col)
	const iSumlev = idx("SUMLEV")
	const iState = idx("STATE")
	const iCounty = idx("COUNTY")
	const iName = idx("CTYNAME")
	const iPop = idx("POPESTIMATE2023")

	const records: CountyRecord[] = []

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!.trim()

		if (!line) continue
		const cols = line.split(",")

		if (cols[iSumlev] !== "050") continue // county rows only
		const stateFips = cols[iState]!.padStart(2, "0")
		const countyFips = cols[iCounty]!.padStart(3, "0")
		const geoid = stateFips + countyFips
		const name = cols[iName] ?? ""
		const pop2023 = Number(cols[iPop]) || 0
		records.push({ stateFips, countyFips, geoid, name, pop2023 })
	}

	// Sort descending by population (highest first → most coverage early)
	records.sort((a, b) => b.pop2023 - a.pop2023)

	return records
}

/**
 * Load (or generate) the ranked county list. On first run this downloads the Census CSV; on subsequent runs it reads
 * the cached JSON file.
 */
async function loadRankedCounties(): Promise<CountyRecord[]> {
	if (existsSync(RANKED_FILE)) {
		return JSON.parse(readFileSync(RANKED_FILE, "utf8"))
	}
	const records = await fetchAndBuildRanking()
	mkdirSync(path.dirname(RANKED_FILE), { recursive: true })
	writeFileSync(RANKED_FILE, JSON.stringify(records, null, 2))
	console.error(`Saved county ranking → ${RANKED_FILE} (${records.length} counties)`)

	return records
}

// ---------------------------------------------------------------------------
// HTTP utilities
// ---------------------------------------------------------------------------

/** Simple GET-to-text over HTTPS with redirect following (≤3 hops). */
function fetchText(url: string, redirectsLeft = 3): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = https.get(url, (res) => {
			const status = res.statusCode ?? 0

			if (status >= 300 && status < 400 && res.headers.location) {
				if (redirectsLeft <= 0) return reject(new Error(`Too many redirects: ${url}`))
				resolve(fetchText(res.headers.location, redirectsLeft - 1))

				return
			}

			if (status !== 200) {
				return reject(new Error(`HTTP ${status} for ${url}`))
			}
			const chunks: Buffer[] = []
			res.on("data", (c) => chunks.push(c))
			res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
		})
		req.on("error", reject)
	})
}

/** Download a URL to a local file path, with retry on 5xx / network errors. */
async function downloadFile(url: string, dest: string, retries = 3): Promise<void> {
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			await _downloadOnce(url, dest)

			return
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			const status = message.match(/HTTP (\d+)/)?.[1]
			const retryable = !status || Number(status) >= 500

			if (!retryable || attempt === retries) throw err
			const delay = attempt * 2000
			console.error(`  [retry ${attempt}/${retries}] ${path.basename(dest)}: ${message} — waiting ${delay}ms`)
			await new Promise((r) => setTimeout(r, delay))
		}
	}
}

function _downloadOnce(url: string, dest: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const follow = (u: string, hopsLeft: number) => {
			if (hopsLeft <= 0) return reject(new Error(`Too many redirects: ${url}`))
			const req = https.get(u, (res) => {
				const status = res.statusCode ?? 0

				if (status >= 300 && status < 400 && res.headers.location) {
					res.resume()
					follow(res.headers.location, hopsLeft - 1)

					return
				}

				if (status !== 200) {
					res.resume()

					return reject(new Error(`HTTP ${status} for ${u}`))
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
 * Unpack a TIGER EDGES ZIP into --edges-dir using the system `unzip` command. Only extracts files whose names end with
 * `.shp`, `.dbf`, `.prj`, `.shx` — the shapefile components DuckDB needs. Silently overwrites existing files
 * (idempotent at the shapefile level).
 */
function extractEdgesZip(zipPath: string, destDir: string): void {
	// unzip -o (overwrite) -j (junk paths) <zip> *.shp *.dbf *.prj *.shx -d <dest>
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

type DownloadTask = { geoid: string; zipURL: string; zipPath: string }

/** Download and unpack a list of county ZIPs with capped parallelism. */
async function downloadParallel(
	tasks: DownloadTask[],
	concurrency: number,
	edgesDir: string
): Promise<{ downloaded: number; skipped: number; failed: string[] }> {
	let downloaded = 0
	let skipped = 0
	const failed: string[] = []
	let idx = 0

	async function worker() {
		while (idx < tasks.length) {
			const task = tasks[idx++]!
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
					console.error(`  [warn] re-extract failed for ${task.geoid}: ${err instanceof Error ? err.message : err}`)
				}
			}

			try {
				await downloadFile(task.zipURL, task.zipPath)
				extractEdgesZip(task.zipPath, edgesDir)
				downloaded++
			} catch (err) {
				console.error(`  [fail] ${task.geoid}: ${err instanceof Error ? err.message : err}`)
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

type ShardBuildResult = { wallMs: number; segments: number; counties: number }

/**
 * Build one state's interpolation shard DB. Returns wall-clock ms + segment count from the script's stdout, or `null`
 * when the shard already exists and `--force` was not passed.
 */
function buildStateShard(
	stateAbbr: string,
	edgesDir: string,
	outDir: string,
	release: string,
	force: boolean
): ShardBuildResult | null {
	const outDB = path.join(outDir, `interpolation-us-${stateAbbr.toLowerCase()}.db`)

	if (existsSync(outDB) && !force) {
		console.error(`  [skip] ${stateAbbr}: shard already exists at ${outDB} (--force to rebuild)`)

		return null
	}

	mkdirSync(outDir, { recursive: true })
	const t0 = Date.now()
	const result = spawnSync(
		process.execPath,
		[
			CLI_ENTRY,
			"situs",
			"interpolation-shard",
			"--state",
			stateAbbr,
			"--edges-dir",
			edgesDir,
			"--release",
			release,
			"--out",
			outDB,
		],
		{
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
		}
	)
	const wallMs = Date.now() - t0

	if (result.status !== 0) {
		console.error(`  [fail] ${stateAbbr}: situs interpolation-shard exited ${result.status}`)
		console.error(stripAnsi(result.stderr ?? "").trim())

		return { wallMs, segments: 0, counties: 0 }
	}

	// The child's parse-relevant facts span its Ink summary (stdout: "N segment-sides → …") + plain
	// progress (stderr: "N county shapefiles for …") — combine + strip ANSI, then match WITHOUT line
	// anchors so the summary's "✓ " render prefix doesn't defeat the regex.
	const stdout = stripAnsi(result.stdout ?? "")
	const stderr = stripAnsi(result.stderr ?? "")
	const combined = `${stdout}\n${stderr}`
	const segMatch = combined.match(/(\d+) segment-sides/)
	const segments = segMatch ? Number(segMatch[1]) : 0
	const countyMatch = combined.match(/(\d+) county shapefiles/)
	const counties = countyMatch ? Number(countyMatch[1]) : 0

	// Echo the child's output with a state prefix.
	for (const line of stdout.trim().split("\n")) {
		if (line) {
			console.error(`  [${stateAbbr}] ${line}`)
		}
	}

	if (stderr.trim()) {
		for (const line of stderr.trim().split("\n")) {
			if (line) {
				console.error(`  [${stateAbbr}:stderr] ${line}`)
			}
		}
	}

	return { wallMs, segments, counties }
}

type StateResult = { state: string; counties: number; segments: number; wallMs: number; skipped?: boolean }

const SitusInterpolation: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [summary, setSummary] = useState<string[]>()

	useEffect(() => {
		void (async () => {
			try {
				const EDGES_DIR = options.edgesDir
				const OUT_DIR = options.outDir ?? dataRootPath("interpolation")
				const RELEASE = options.release
				const CONCURRENCY = options.concurrency
				const FORCE = options.force
				const DOWNLOAD_ONLY = options.downloadOnly
				const BUILD_ONLY = options.buildOnly

				// States to process — filtered by --states flag if provided.
				const TARGET_STATES = options.states
					? options.states
							.toUpperCase()
							.split(",")
							.map((s) => s.trim())
							.filter((s) => s in STATE_FIPS)
					: Object.keys(STATE_FIPS)

				if (TARGET_STATES.length === 0) {
					throw new Error("No valid states specified. Check --states values against the STATE_FIPS map.")
				}

				console.error("=== National TIGER interpolation shard build ===")
				console.error(`states:      ${TARGET_STATES.join(", ")}`)
				console.error(`edges-dir:   ${EDGES_DIR}`)
				console.error(`out-dir:     ${OUT_DIR}`)
				console.error(`concurrency: ${CONCURRENCY}`)
				console.error(`release:     ${RELEASE}`)

				if (FORCE) {
					console.error("force:       true (re-building existing shards)")
				}
				console.error("")

				mkdirSync(EDGES_DIR, { recursive: true })
				mkdirSync(OUT_DIR, { recursive: true })

				// ── Step 1: load county population ranking ─────────────────────────────
				console.error("Step 1: county population ranking")
				const allCounties = await loadRankedCounties()
				console.error(`  ${allCounties.length} counties in ranking`)

				// Filter to target states only
				const targetFipsSet = new Set(TARGET_STATES.map((s) => STATE_FIPS[s]))
				let counties = allCounties.filter((c) => targetFipsSet.has(c.stateFips))

				// Apply --top-counties cap if set
				const topN = options.topCounties ?? null

				if (topN !== null) {
					counties = counties.slice(0, topN)
					console.error(`  capped to top ${topN} counties by population`)
				}

				console.error(`  ${counties.length} counties to process`)
				console.error("")

				// ── Step 2: download ZIPs ──────────────────────────────────────────────
				if (!BUILD_ONLY) {
					console.error(`Step 2: downloading TIGER EDGES ZIPs (concurrency=${CONCURRENCY})`)
					const BASE = "https://www2.census.gov/geo/tiger/TIGER2023/EDGES"
					const tasks: DownloadTask[] = counties.map((c) => {
						const geoid = c.geoid // 5-digit: stateFips + countyFips
						const zipFile = `tl_2023_${geoid}_edges.zip`

						return {
							geoid,
							zipURL: `${BASE}/${zipFile}`,
							zipPath: path.join(EDGES_DIR, zipFile),
						}
					})
					const { downloaded, skipped, failed } = await downloadParallel(tasks, CONCURRENCY, EDGES_DIR)
					console.error(`  downloaded: ${downloaded}, skipped (already present): ${skipped}, failed: ${failed.length}`)

					if (failed.length > 0) {
						console.error(`  failed GEOIDs: ${failed.slice(0, 20).join(", ")}${failed.length > 20 ? " …" : ""}`)
					}
					console.error("")
				}

				if (DOWNLOAD_ONLY) {
					console.error("--download-only: stopping after downloads.")
					setSummary([`interpolation: ${OUT_DIR}`, "--download-only: stopped after downloads."])

					return
				}

				// ── Step 3: determine which states have ≥1 county SHP ─────────────────
				console.error("Step 3: building per-state shards")
				// States from our target list that have at least one downloaded county SHP
				const availableStates = TARGET_STATES.filter((abbr) => {
					const fips = STATE_FIPS[abbr]
					const pattern = new RegExp(`tl_\\d+_${fips}\\d{3}_edges\\.shp$`)

					return readdirSync(EDGES_DIR).some((f) => pattern.test(f))
				})

				if (availableStates.length === 0) {
					throw new Error("No county SHPs found in edges-dir for any target state. Run without --build-only first.")
				}
				console.error(`  ${availableStates.length} states with available SHPs: ${availableStates.join(", ")}`)
				console.error("")

				// ── Step 4: build shards sequentially ─────────────────────────────────
				// Sequential (not parallel): each shard script uses DuckDB + SQLite; they're already
				// I/O + DuckDB-parallel internally. Running states concurrently risks memory OOM on the
				// 32K-row state builds and complicates progress reporting.
				const wallStart = Date.now()
				let totalSegments = 0
				let builtStates = 0
				const stateResults: StateResult[] = []

				for (const abbr of availableStates) {
					console.error(`Building ${abbr}…`)
					const result = buildStateShard(abbr, EDGES_DIR, OUT_DIR, RELEASE, FORCE)

					if (result === null) {
						// skipped (already exists, no --force)
						stateResults.push({ state: abbr, counties: 0, segments: 0, wallMs: 0, skipped: true })
						continue
					}
					builtStates++
					totalSegments += result.segments
					stateResults.push({
						state: abbr,
						counties: result.counties,
						segments: result.segments,
						wallMs: result.wallMs,
					})
					const elapsed = (result.wallMs / 1000).toFixed(1)
					console.error(
						`  ${abbr}: ${result.counties} counties, ${result.segments.toLocaleString()} segment-sides, ${elapsed}s`
					)
					console.error("")
				}

				// ── Summary ────────────────────────────────────────────────────────────
				const totalWallMs = Date.now() - wallStart
				const lines = [
					`interpolation: ${OUT_DIR}`,
					`States built:    ${builtStates} / ${availableStates.length}`,
					`Total segments:  ${totalSegments.toLocaleString()}`,
					`Wall clock:      ${(totalWallMs / 1000).toFixed(1)}s`,
					`Per-state:`,
				]

				for (const r of stateResults) {
					if (r.skipped) {
						lines.push(`  ${r.state}: SKIPPED (already built)`)
					} else {
						lines.push(
							`  ${r.state}: ${r.counties} counties · ${r.segments.toLocaleString()} segments · ${(r.wallMs / 1000).toFixed(1)}s`
						)
					}
				}
				setSummary(lines)
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		})()
	}, [options])

	useEffect(() => {
		if (summary || error) {
			setImmediate(() => process.exit(error ? 1 : 0))
		}
	}, [summary, error])

	if (error) return <Text color="red">✗ {error}</Text>

	if (summary) {
		return (
			<Box flexDirection="column">
				{summary.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null // progress streams to stderr until the summary lands
}

export default SitusInterpolation
