/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { spawnProcessSync } from "@mailwoman/core/process"
import { CommandError } from "@mailwoman/core/scripting/command"
import { scriptEntryPath } from "@mailwoman/core/scripting/utils"
import { streamToDisk } from "@mailwoman/core/utils"
import { sleep } from "@mailwoman/core/utils/sleep"
import { interpolationDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { Box, Text } from "ink"
import { basename, dirname, PathBuilder, resolvePath, resolvePathBuilder, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import {
	type CommandSpec,
	CommandTaskResult,
	type CommandComponent,
	positiveInteger,
	splitUSStateCodes,
	stripAnsi,
	useCommandTask,
} from "#cli-kit"

/**
 * The lowest HTTP status that a download retries.
 * Client errors are not retried.
 */
const HTTP_SERVER_ERROR_MIN = 500

/**
 * The number of failed GEOIDs printed before the list is truncated.
 */
const MAX_LISTED_FAILURES = 20

/**
 * The command specification for `mailwoman situs interpolation`.
 *
 * The command downloads TIGER EDGES county archives, most populous counties first,
 * and then runs `situs interpolation-database` once per state.
 * It skips counties that are already unpacked and state databases that already exist
 * unless `--force` is set.
 */
export const spec = {
	name: "interpolation",
	description: "Download TIGER EDGES and build interpolation databases",
	options: {
		"edges-dir": {
			type: "string",
			default: resolvePath(dataRootPath("census", "tiger2023-edges")),
			description: "TIGER download directory",
		},
		"out-dir": { type: "string", description: "Database output directory" },
		release: { type: "string", default: "TIGER2023", description: "TIGER vintage" },
		states: { type: "string", description: "Comma-separated states" },
		"top-counties": { type: "number", validate: positiveInteger, description: "Most-populated county limit" },
		concurrency: { type: "number", default: 12, validate: positiveInteger, description: "Parallel downloads" },
		force: { type: "boolean", default: false, description: "Rebuild existing databases" },
		"download-only": { type: "boolean", default: false, description: "Only download and unpack" },
		"build-only": { type: "boolean", default: false, description: "Only build existing downloads" },
	},
} as const satisfies CommandSpec

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

/**
 * The cached county-population ranking.
 */
const RANKED_FILE = repoRootPathBuilder("mailwoman", "data", "county-population-ranked.json")

/**
 * The entry script of the running CLI, which the command re-invokes for each state build.
 */
const CLI_ENTRY = scriptEntryPath()

interface CountyRecord {
	stateFips: string
	countyFips: string
	geoid: string
	name: string
	pop2023: number
}

/**
 * Fetches the Census population estimates and returns the counties sorted by descending population.
 */
async function fetchAndBuildRanking(): Promise<CountyRecord[]> {
	console.error("Fetching Census Population Estimates CSV (co-est2023-alldata.csv)…")

	const url =
		"https://www2.census.gov/programs-surveys/popest/datasets/2020-2023/counties/totals/co-est2023-alldata.csv"

	const csv = await fetchText(url)
	const lines = [...TextSpliterator.from(csv)]
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

		// Summary level 050 marks a county row.
		if (cols[iSumlev] !== "050") continue
		const stateFips = cols[iState]!.padStart(2, "0")
		const countyFips = cols[iCounty]!.padStart(3, "0")
		const geoid = stateFips + countyFips
		const name = cols[iName] ?? ""
		const pop2023 = Number(cols[iPop]) || 0
		records.push({ stateFips, countyFips, geoid, name, pop2023 })
	}

	records.sort((a, b) => b.pop2023 - a.pop2023)

	return records
}

/**
 * Reads the cached county ranking, and fetches and caches it when the file is missing.
 */
async function loadRankedCounties(): Promise<CountyRecord[]> {
	if (await pathExists(RANKED_FILE)) {
		return await readLocalJSONFile<CountyRecord[]>(RANKED_FILE)
	}

	const records = await fetchAndBuildRanking()
	await makeDirectories(dirname(RANKED_FILE))
	await writeLocalJSONFile(records, RANKED_FILE)

	console.error(`Saved county ranking → ${RANKED_FILE} (${records.length} counties)`)

	return records
}

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url, { redirect: "follow" })

	if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)

	return await response.text()
}

/**
 * Downloads a URL to a file, retrying on server and network errors.
 */
async function downloadFile(url: string, dest: PathBuilderLike, retries = 3): Promise<void> {
	// oxlint-disable-next-line eslint/no-unreachable-loop -- the catch falls through to the next attempt when the error is retryable
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			await streamToDisk({ url, destination: dest, context: "situs interpolation" })

			return
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			const status = message.match(/HTTP (\d+)/)?.[1]
			const retryable = !status || Number(status) >= HTTP_SERVER_ERROR_MIN

			if (!retryable || attempt === retries) throw error
			const delay = attempt * 2000

			console.error(`  [retry ${attempt}/${retries}] ${basename(dest)}: ${message} — waiting ${delay}ms`)

			await sleep(delay)
		}
	}
}

/**
 * The shapefile members that DuckDB needs from a TIGER EDGES archive.
 */
const SHAPEFILE_MEMBERS = /\.(?:shp|dbf|prj|shx)$/i

/**
 * Unpacks the shapefile members of an archive into a flat directory, overwriting existing files.
 */
async function extractEdgesZip(zipPath: PathBuilderLike, destDir: PathBuilderLike): Promise<void> {
	const { extractZipEntries } = await import("@mailwoman/core/fs/zip")

	await extractZipEntries(zipPath, destDir, { selector: SHAPEFILE_MEMBERS, flatten: true })
}

interface DownloadTask {
	geoid: string
	zipURL: string
	zipPath: PathBuilder
}

/**
 * Downloads and unpacks county archives with at most `concurrency` transfers in flight.
 */
async function downloadParallel(
	tasks: DownloadTask[],
	concurrency: number,
	edgesDir: PathBuilder
): Promise<{ downloaded: number; skipped: number; failed: string[] }> {
	let downloaded = 0
	let skipped = 0
	const failed: string[] = []
	let idx = 0

	async function worker() {
		while (idx < tasks.length) {
			const task = tasks[idx++]!
			const shpBase = `tl_2023_${task.geoid}_edges.shp`
			const shpPath = edgesDir(shpBase)

			if (await pathExists(shpPath)) {
				skipped++

				continue
			}

			// An archive without its shapefile is left from an interrupted run, so it only needs unpacking.
			if (await pathExists(task.zipPath)) {
				try {
					await extractEdgesZip(task.zipPath, edgesDir)

					skipped++

					continue
				} catch (error) {
					console.error(
						`  [warn] re-extract failed for ${task.geoid}: ${error instanceof Error ? error.message : error}`
					)
				}
			}

			try {
				await downloadFile(task.zipURL, task.zipPath)
				await extractEdgesZip(task.zipPath, edgesDir)

				downloaded++
			} catch (error) {
				console.error(`  [fail] ${task.geoid}: ${error instanceof Error ? error.message : error}`)

				failed.push(task.geoid)
			}
		}
	}

	await Promise.all(Array.from({ length: concurrency }, worker))

	return { downloaded, skipped, failed }
}

interface DatabaseBuildResult {
	wallMs: number
	segments: number
	counties: number
}

/**
 * Builds one state's interpolation database in a child process.
 *
 * @returns The wall-clock time and the counts parsed from the child's output, or `null`
 * when the database already exists and `force` is false.
 * A failed child returns zero counts.
 */
async function buildStateDatabase(
	stateAbbr: string,
	edgesDir: PathBuilderLike,
	outDir: PathBuilderLike,
	release: string,
	force: boolean
): Promise<DatabaseBuildResult | null> {
	const outDB = resolvePathBuilder(outDir, `interpolation-us-${stateAbbr.toLowerCase()}.db`)

	if ((await pathExists(outDB)) && !force) {
		console.error(`  [skip] ${stateAbbr}: database already exists at ${outDB} (--force to rebuild)`)

		return null
	}

	await makeDirectories(outDir)
	const t0 = Date.now()

	const result = spawnProcessSync(
		process.execPath,
		[
			CLI_ENTRY,
			"situs",
			"interpolation-database",
			"--state",
			stateAbbr,
			"--edges-dir",
			resolvePath(edgesDir),
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
		console.error(`  [fail] ${stateAbbr}: situs interpolation-database exited ${result.status}`)
		console.error(stripAnsi(result.stderr ?? "").trim())

		return { wallMs, segments: 0, counties: 0 }
	}

	// The segment count appears on stdout and the county count on stderr.
	// The patterns have no line anchors because the summary lines carry a render prefix.
	const stdout = stripAnsi(result.stdout ?? "")
	const stderr = stripAnsi(result.stderr ?? "")
	const combined = `${stdout}\n${stderr}`
	const segMatch = combined.match(/(\d+) segment-sides/)
	const segments = segMatch ? Number(segMatch[1]) : 0
	const countyMatch = combined.match(/(\d+) county shapefiles/)
	const counties = countyMatch ? Number(countyMatch[1]) : 0

	for (const line of TextSpliterator.from(stdout.trim())) {
		if (line) {
			console.error(`  [${stateAbbr}] ${line}`)
		}
	}

	if (stderr.trim()) {
		for (const line of TextSpliterator.from(stderr.trim())) {
			if (line) {
				console.error(`  [${stateAbbr}:stderr] ${line}`)
			}
		}
	}

	return { wallMs, segments, counties }
}

interface StateResult {
	state: string
	counties: number
	segments: number
	wallMs: number
	skipped?: boolean
}

const SitusInterpolation: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const EDGES_DIR = PathBuilder.from(options.edgesDir)
		const OUT_DIR = options.outDir ?? interpolationDatabasePath
		const RELEASE = options.release
		const CONCURRENCY = options.concurrency
		const FORCE = options.force
		const DOWNLOAD_ONLY = options.downloadOnly
		const BUILD_ONLY = options.buildOnly

		const TARGET_STATES = options.states ? splitUSStateCodes(options.states) : Object.keys(STATE_FIPS)

		if (!TARGET_STATES.length) {
			throw new CommandError("No valid states specified. Check --states values against the STATE_FIPS map.")
		}

		console.error("=== National TIGER interpolation database build ===")
		console.error(`states:      ${TARGET_STATES.join(", ")}`)
		console.error(`edges-dir:   ${EDGES_DIR}`)
		console.error(`out-dir:     ${OUT_DIR}`)
		console.error(`concurrency: ${CONCURRENCY}`)
		console.error(`release:     ${RELEASE}`)

		if (FORCE) {
			console.error("force:       true (re-building existing databases)")
		}

		console.error("")

		await makeDirectories(EDGES_DIR)
		await makeDirectories(OUT_DIR)

		console.error("Step 1: county population ranking")

		const allCounties = await loadRankedCounties()

		console.error(`  ${allCounties.length} counties in ranking`)

		const targetFipsSet = new Set(TARGET_STATES.map((s) => STATE_FIPS[s]))
		let counties = allCounties.filter((c) => targetFipsSet.has(c.stateFips))

		const topN = options.topCounties ?? null

		if (topN !== null) {
			counties = counties.slice(0, topN)

			console.error(`  capped to top ${topN} counties by population`)
		}

		console.error(`  ${counties.length} counties to process`)
		console.error("")

		if (!BUILD_ONLY) {
			console.error(`Step 2: downloading TIGER EDGES ZIPs (concurrency=${CONCURRENCY})`)

			const BASE = "https://www2.census.gov/geo/tiger/TIGER2023/EDGES"

			const tasks: DownloadTask[] = counties.map((c) => {
				const geoid = c.geoid
				const zipFile = `tl_2023_${geoid}_edges.zip`

				return {
					geoid,
					zipURL: `${BASE}/${zipFile}`,
					zipPath: EDGES_DIR(zipFile),
				}
			})

			const { downloaded, skipped, failed } = await downloadParallel(tasks, CONCURRENCY, EDGES_DIR)

			console.error(`  downloaded: ${downloaded}, skipped (already present): ${skipped}, failed: ${failed.length}`)

			if (failed.length) {
				console.error(
					`  failed GEOIDs: ${failed.slice(0, MAX_LISTED_FAILURES).join(", ")}${failed.length > MAX_LISTED_FAILURES ? " …" : ""}`
				)
			}

			console.error("")
		}

		if (DOWNLOAD_ONLY) {
			console.error("--download-only: stopping after downloads.")

			return [`interpolation: ${OUT_DIR}`, "--download-only: stopped after downloads."]
		}

		console.error("Step 3: building per-state databases")

		// The listing is read once so that the filter callback can stay synchronous.
		const edgesEntries = await Globerator.files("shp", { cwd: EDGES_DIR, absolute: false, recursive: false }).toArray()

		const availableStates = TARGET_STATES.filter((abbr) => {
			const fips = STATE_FIPS[abbr]
			const pattern = new RegExp(`tl_\\d+_${fips}\\d{3}_edges\\.shp$`)

			return edgesEntries.some((f) => pattern.test(f))
		})

		if (!availableStates.length) {
			throw new CommandError("No county SHPs found in edges-dir for any target state. Run without --build-only first.")
		}

		console.error(`  ${availableStates.length} states with available SHPs: ${availableStates.join(", ")}`)
		console.error("")

		// States build one at a time because each build already runs DuckDB in parallel,
		// and concurrent builds risk running out of memory.
		const wallStart = Date.now()
		let totalSegments = 0
		let builtStates = 0
		const stateResults: StateResult[] = []

		for (const abbr of availableStates) {
			console.error(`Building ${abbr}…`)

			const result = await buildStateDatabase(abbr, EDGES_DIR, OUT_DIR, RELEASE, FORCE)

			if (result === null) {
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

		return lines
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null
}

export default SitusInterpolation
