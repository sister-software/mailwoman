/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the US address layer, one file set per state, from NAD release 24, Overture's non-NAD rows and the
 *   OpenAddresses source runs the plan admits.
 */

import { US_STATE_ABBREVIATIONS, US_TERRITORY_ABBREVIATIONS } from "@mailwoman/codex/us/state"
import { usUnitIdentifier } from "@mailwoman/codex/us/unit/designator"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { openWriteStream } from "@mailwoman/core/fs/streams"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { removePathIfPresent, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { extractZipEntry } from "@mailwoman/core/fs/zip"
import { fileURLToPath } from "@mailwoman/core/module/file-url"
import { forkProcess } from "@mailwoman/core/process"
import { availableParallelism } from "@mailwoman/core/utils/system"
import {
	ADDRESS_DUPLICATE_DISTANCE_KM,
	ADDRESS_DUPLICATE_STACK_LIMIT,
	type AddressDuplicateRule,
} from "@mailwoman/resolver-wof-sqlite/address/duplicate"
import { writeAddressLayerAttribution } from "@mailwoman/resolver-wof-sqlite/address/keys/attribution"
import {
	ADDRESS_LAYER_STACK_LIMIT,
	buildAddressLayer,
	type AddressLayerManifest,
	type AddressSourceTerms,
} from "@mailwoman/resolver-wof-sqlite/address/keys/build"
import {
	ADDRESS_LAYER_SPLIT_ROWS,
	addressLayerFiles,
	addressLayerManifestPath,
	describeAddressLayerFile,
	writeAddressLayerManifest,
	type AddressLayerCountryManifest,
} from "@mailwoman/resolver-wof-sqlite/address/keys/layout"
import type { AddressRecord } from "@mailwoman/resolver-wof-sqlite/address/record"
import { openSubdivisionBoundsCheck } from "@mailwoman/resolver-wof-sqlite/address/subdivision-bounds"
import { dirname, resolvePath, type PathBuilder, type PathBuilderLike } from "path-ts"

import { createUnitSplitter, type UnitSplitter } from "#adapters/street/unit"
import { isAdmittedSource } from "#address-records/admission"
import {
	openAddressesSourceCacheName,
	readOpenAddressesGeoJSONRunRecords,
	readOpenAddressesRunRecords,
} from "#address-records/openaddresses"
import { readOvertureAddressRecords } from "#address-records/overture"
import { escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { recordPathFor } from "#parquet/record"
import { readNADAddressRecords } from "#us/address-records/nad"

/**
 * The run counts a parallel build's worker reports for its state.
 */
export interface USStateWorkerResult {
	refusedRuns: number
	missingRuns: number
}

/**
 * One OpenAddresses run as a plan lists it, with the license its source definition records.
 */
export interface OpenAddressesPlanEntry {
	member: string
	license: unknown
	/**
	 * The job's layer name, such as `city`, `county` or `state`, which ranks the
	 * run against the state's other runs.
	 */
	level?: string | null
	/**
	 * When the job last updated.
	 * Runs of one level are ordered by it.
	 */
	updated?: string | null
	/**
	 * The job's feature count.
	 *
	 * A parallel build starts its states in descending order of it.
	 */
	features?: number | null
	skip?: boolean
}

export interface BuildUSAddressLayerOptions {
	/**
	 * The data root's `db` directory, under which `addresses/<region>/<version>/` is written.
	 */
	root: PathBuilderLike
	version: string
	/**
	 * The published version whose regions a new version's first build keeps,
	 * for the states it does not rebuild.
	 */
	baseVersion?: string
	nadParquet: PathBuilderLike
	/**
	 * The Overture US address Parquet file whose non-NAD rows join NAD's.
	 */
	overtureParquet: PathBuilderLike
	/**
	 * The OpenAddresses runs to consider, and the directory of their cached `<member with __>.zip` archives.
	 */
	openAddresses: { plan: readonly OpenAddressesPlanEntry[]; cache: PathBuilderLike }
	/**
	 * The states to build, as USPS codes.
	 * Every state and DC when absent.
	 */
	states?: readonly string[]
	/**
	 * Regions to leave out of the manifest, such as `us-hi` while its files fall short of the current ones.
	 * Their files are still built.
	 */
	omitFromManifest?: readonly string[]
	/**
	 * The commit the build ran from, for each file's `layer_manifest`.
	 */
	buildSHA: string
	/**
	 * The Who's On First admin database a record's point is checked against its state's bounding box in.
	 */
	adminDatabase: PathBuilderLike
	/**
	 * The number of states to build at once, each in its own worker process.
	 * One builds them in this process.
	 */
	jobs?: number
	/**
	 * SQLite sorter helper threads for each state's build.
	 *
	 * @defaultValue The host's cores divided by `jobs`, between 1 and 8.
	 */
	sortThreads?: number
	/**
	 * Keep each region this version already holds, read from its `build.json`, and build only the others.
	 *
	 * A region with files and no `build.json` is refused, because its record
	 * and refusal counts cannot be read.
	 */
	resume?: boolean
	/**
	 * Whether to write the US manifest.
	 *
	 * A parallel build's worker builds one state and leaves the manifest to the parent.
	 *
	 * @defaultValue true
	 */
	writeManifest?: boolean
	onState?: (summary: USStateBuild) => void
}

/**
 * What a region's `build.json` records: its manifest entry and its build summary.
 */
interface USRegionBuildRecord {
	region: AddressLayerCountryManifest["regions"][number]
	build: USStateBuild
}

/**
 * Where a region's `build.json` sits, beside its `lookup.db`.
 */
function regionBuildRecordPath(root: PathBuilderLike, region: string, version: string): string {
	return resolvePath(dirname(addressLayerFiles(root, region, version).lookup.toString()), "build.json").toString()
}

/**
 * What one state's build wrote.
 */
export interface USStateBuild {
	state: string
	records: number
	nad: number
	overture: number
	openAddresses: number
	runs: number
	seconds: number
	/**
	 * Records left out of the state, per source id and reason.
	 */
	refused: Record<string, Record<string, number>>
}

export interface USAddressLayerBuild {
	/**
	 * The US manifest, or null for a build that was told to write none.
	 */
	manifest: PathBuilder | null
	states: USStateBuild[]
	refusedRuns: number
	missingRuns: number
}

const NAD_TERMS: AddressSourceTerms = { license: "public-domain", authority: "U.S. Department of Transportation" }

/**
 * The Overture datasets other than NAD that hold rows for `state`, read with one DuckDB scan.
 */
async function overtureDatasets(overture: PathBuilderLike, state: string): Promise<string[]> {
	using db = await openDuckDB({ memoryLimitBytes: 4 * 1024 ** 3, threads: 4 })

	const rows = (
		await db.runAndReadAll(
			`SELECT DISTINCT sources[1].dataset AS dataset FROM read_parquet('${escapeSQLString(overture.toString())}')
			 WHERE country = 'US' AND address_levels[1].value = '${escapeSQLString(state)}' AND sources[1].dataset <> 'NAD'`
		)
	).getRowObjects()

	return rows.map((row) => row["dataset"]).filter((name): name is string => typeof name === "string" && name.length > 0)
}

/**
 * The cached archive of one OpenAddresses run from the anonymous results endpoint.
 */
function runArchive(cache: PathBuilderLike, member: string): string {
	return resolvePath(cache, `${member.replaceAll("/", "__")}.zip`).toString()
}

/**
 * The cached batch API job output of one OpenAddresses run, as `fetchOpenAddressesSources` writes it.
 */
function runGeoJSON(cache: PathBuilderLike, member: string): string {
	return resolvePath(cache, openAddressesSourceCacheName(member)).toString()
}

/**
 * Where the cache holds a run, preferring the batch job output, or null when it holds neither form.
 */
export async function cachedRun(
	cache: PathBuilderLike,
	member: string
): Promise<{ path: string; geojson: boolean } | null> {
	const geojson = runGeoJSON(cache, member)

	if (await pathExists(geojson)) return { path: geojson, geojson: true }

	const archive = runArchive(cache, member)

	return (await pathExists(archive)) ? { path: archive, geojson: false } : null
}

async function* stateRecords(
	options: BuildUSAddressLayerOptions,
	state: string,
	hasNAD: boolean,
	runs: readonly string[],
	scratch: PathBuilder,
	units: UnitSplitter
): AsyncGenerator<AddressRecord> {
	if (hasNAD) {
		yield* readNADAddressRecords(options.nadParquet, { where: `"State" = '${escapeSQLString(state)}'` })
	}

	yield* readOvertureAddressRecords(options.overtureParquet, {
		where: `country = 'US' AND address_levels[1].value = '${escapeSQLString(state)}' AND sources[1].dataset <> 'NAD'`,
		streetLocale: "en",
		units,
	})

	for (const member of runs) {
		const cached = await cachedRun(options.openAddresses.cache, member)

		if (!cached) throw new Error(`the OpenAddresses cache lost ${member} after the plan admitted it`)

		if (cached.geojson) {
			yield* readOpenAddressesGeoJSONRunRecords(cached.path, member, "en", units)

			continue
		}

		const csv = scratch(`${member.replaceAll("/", "__")}.csv`)

		await extractZipEntry(cached.path, `${member}.csv`, csv)

		try {
			yield* readOpenAddressesRunRecords(csv, member, "en", units)
		} finally {
			await removePathIfPresent(csv)
		}
	}
}

/**
 * The US layer's source ranking, highest first: NAD, then OpenAddresses runs by
 * their publisher's level, then Overture's datasets.
 *
 * A city's address points rank above a county's, and a county's above a statewide file.
 * Runs of one level rank newest job first.
 *
 * Overture's datasets rank last because most are copies of OpenAddresses runs from an earlier release.
 */
export const US_ADDRESS_SOURCE_RANKING = [
	"usgov-nad",
	"openaddresses:city",
	"openaddresses:county",
	"openaddresses:state",
	"openaddresses:other",
	"overture:*",
] as const

/**
 * The OpenAddresses layer names that state each publisher level, as source definitions spell them.
 *
 * A name outside the table, such as `parcels` or `condos`, ranks as `other`, below every listed level.
 */
const OPENADDRESSES_LAYER_LEVELS: Readonly<Record<string, "city" | "county" | "state">> = {
	city: "city",
	town: "city",
	incorporated: "city",
	county: "county",
	"county-gis": "county",
	"county-incorporated": "county",
	parish: "county",
	state: "state",
}

const OPENADDRESSES_LEVEL_ORDER = ["city", "county", "state", "other"] as const

/**
 * Ranks every source a state's build reads, lowest first, for the duplicate rule.
 *
 * NAD ranks 0.
 * Each OpenAddresses run takes its own rank, ordered by its level in
 * {@linkcode US_ADDRESS_SOURCE_RANKING}, then by newest job, then by member.
 *
 * Overture's datasets rank after every run, so one run's record repeated by another run,
 * or by Overture, is dropped from the lower-ranked source.
 */
export function usAddressSourceRanks(runs: readonly OpenAddressesPlanEntry[]): (source: string) => number {
	const levelIndex = (level: string | null | undefined) =>
		OPENADDRESSES_LEVEL_ORDER.indexOf((level && OPENADDRESSES_LAYER_LEVELS[level]) || "other")

	const ordered = runs.toSorted(
		(a, b) =>
			levelIndex(a.level) - levelIndex(b.level) ||
			Date.parse(b.updated ?? "") - Date.parse(a.updated ?? "") ||
			a.member.localeCompare(b.member)
	)

	const ranks = new Map(ordered.map(({ member }, index) => [`openaddresses:${member}`, index + 1]))
	const overture = ordered.length + 1

	return (source) => {
		if (source === "usgov-nad") return 0

		const run = ranks.get(source)

		if (typeof run === "number") return run

		return source.startsWith("overture:") ? overture : overture + 1
	}
}

/**
 * The duplicate rule for one state's build, ranking its sources by {@linkcode usAddressSourceRanks}.
 */
function usDuplicateRule(runs: readonly OpenAddressesPlanEntry[]): AddressDuplicateRule {
	return {
		rank: usAddressSourceRanks(runs),
		unitIdentifier: (unit, context) => usUnitIdentifier(unit, context),
	}
}

/**
 * The terms each planned OpenAddresses run's source definition records, keyed by the run's source id.
 */
function recordedRunTerms(plan: readonly OpenAddressesPlanEntry[]): Map<string, unknown> {
	return new Map(plan.map(({ member, license }) => [`openaddresses:${member}`, license]))
}

/**
 * Builds every requested state's `lookup.db` and `detail.db` under `addresses/us-<state>/<version>/`,
 * one state at a time, and writes the US manifest once every state is built.
 *
 * A state takes NAD's rows when release 24 has any, Overture's rows from every dataset other than NAD,
 * and the plan's runs for the state that `isAdmittedSource` admits and the cache holds.
 * A record that a higher-ranked source repeats, by {@linkcode usAddressSourceRanks}, is dropped.
 *
 * Territories are their own ISO 3166-1 countries and are not built here.
 */
export async function buildUSAddressLayer(options: BuildUSAddressLayerOptions): Promise<USAddressLayerBuild> {
	const territories = new Set<string>(US_TERRITORY_ABBREVIATIONS)

	const { rowsByState } = await readLocalJSONFile<{ rowsByState: Record<string, number> }>(
		recordPathFor(options.nadParquet)
	)

	const states = (options.states ?? US_STATE_ABBREVIATIONS.filter((state) => !territories.has(state))).map((state) =>
		state.toUpperCase()
	)

	// A version's files are published under `immutable` cache headers,
	// so a region is built into a version once.
	// A rebuild goes into a new version.
	// Every earlier region's files stay under their own version's path.
	// Under `resume`, a region already built in this version is kept from its `build.json`.
	const built: string[] = []
	const unrecorded: string[] = []
	const resumed: USRegionBuildRecord[] = []
	const toBuild: string[] = []

	for (const state of states) {
		const region = `us-${state.toLowerCase()}`
		const { lookup } = addressLayerFiles(options.root, region, options.version)

		if (!(await pathExists(lookup))) {
			toBuild.push(state)
		} else if (!options.resume) {
			built.push(region)
		} else {
			const recordPath = regionBuildRecordPath(options.root, region, options.version)

			if (await pathExists(recordPath)) {
				resumed.push(await readLocalJSONFile<USRegionBuildRecord>(recordPath))
			} else {
				unrecorded.push(region)
			}
		}
	}

	if (built.length) {
		throw new Error(
			`${built.join(", ")} already built in ${options.version}; build into a new version, ` +
				"because a published version's files are cached as immutable, or pass resume to keep them"
		)
	}

	if (unrecorded.length) {
		throw new Error(
			`${unrecorded.join(", ")} built in ${options.version} with no build.json, so their record and refusal ` +
				"counts cannot be read; remove their files and build them again"
		)
	}

	// A run absent from the cache counts as missing.
	// An absent cache directory would count every run as missing and build each state
	// from its NAD and Overture rows with no OpenAddresses runs.
	if (options.openAddresses.plan.length && !(await pathExists(options.openAddresses.cache))) {
		throw new Error(
			`the OpenAddresses cache ${options.openAddresses.cache} does not exist; ` +
				"if it is on a separate volume, mount it before building"
		)
	}

	const omitted = new Set(options.omitFromManifest)

	const sortThreads =
		options.sortThreads ?? Math.min(8, Math.max(1, Math.floor(availableParallelism() / (options.jobs ?? 1))))

	const recorded = recordedRunTerms(options.openAddresses.plan)
	const units = await createUnitSplitter()

	using bounds = openSubdivisionBoundsCheck(options.adminDatabase)
	const regions: AddressLayerCountryManifest["regions"] = []
	const builds: USStateBuild[] = []
	let refusedRuns = 0
	let missingRuns = 0

	for (const record of resumed) {
		builds.push(record.build)

		if (!omitted.has(record.region.region)) {
			regions.push(record.region)
		}
	}

	await using scratch = await temporaryDirectory("us-address-layer-")

	const buildState = async (state: string): Promise<void> => {
		const region = `us-${state.toLowerCase()}`
		const files = addressLayerFiles(options.root, region, options.version)
		const hasNAD = (rowsByState[state] ?? 0) > 0
		const datasets = await overtureDatasets(options.overtureParquet, state)
		const admitted: OpenAddressesPlanEntry[] = []

		for (const entry of options.openAddresses.plan) {
			const { member, license, skip } = entry

			if (member.split("/")[0] !== "us" || member.split("/")[1] !== state.toLowerCase() || skip) continue

			if (!isAdmittedSource(member, license)) {
				refusedRuns++
			} else if (await cachedRun(options.openAddresses.cache, member)) {
				admitted.push(entry)
			} else {
				missingRuns++
			}
		}

		const runs = admitted.map(({ member }) => member)

		if (!hasNAD && !datasets.length && !runs.length) return

		const sources = new Map<string, AddressSourceTerms>([
			...datasets.map((dataset) => [`overture:${dataset}`, { license: null, authority: null }] as const),
			...runs.map((member) => [`openaddresses:${member}`, { license: null, authority: null }] as const),
		])

		if (hasNAD) {
			sources.set("usgov-nad", NAD_TERMS)
		}

		const manifest: AddressLayerManifest = {
			name: `addresses-${region}`,
			version: options.version,
			tier: "shipped",
			license: "LicenseRef-US-Mixed",
			attribution:
				"U.S. Department of Transportation, National Address Database; OpenAddresses contributors, directly and via Overture Maps",
			source: "usgov-nad+overture+openaddresses",
			sourceVintage: options.version,
			buildCmd: "mailwoman situs layer",
			buildSHA: options.buildSHA,
			freshnessPolicy: "versioned-refresh",
			createdAt: new Date().toISOString().slice(0, 19) + "Z",
		}

		const started = Date.now()

		const summary = await buildAddressLayer({
			records: stateRecords(options, state, hasNAD, runs, scratch.path, units),
			sources,
			manifest,
			lookupPath: files.lookup,
			detailPath: files.detail,
			// The staging database is the build's largest file, so it goes in the scratch directory.
			// `MAILWOMAN_TEMP_ROOT` can place that directory on a disk other than the layer's.
			stagingDirectory: scratch.path,
			sortThreads,
			refuseRecord: (record) => bounds.refuse(record),
			duplicates: usDuplicateRule(admitted),
		})

		let nad = 0
		let overture = 0

		for (const [name, count] of Object.entries(summary.sources)) {
			if (name === "usgov-nad") {
				nad += count
			} else if (name.startsWith("overture:")) {
				overture += count
			}
		}

		const build: USStateBuild = {
			state,
			records: summary.records,
			nad,
			overture,
			openAddresses: summary.records - nad - overture,
			runs: runs.length,
			seconds: Math.round((Date.now() - started) / 1000),
			refused: summary.refused,
		}

		await writeAddressLayerAttribution(options.root, region, options.version, recorded)

		const entry: USRegionBuildRecord["region"] = {
			region,
			subdivision: `US-${state}`,
			records: summary.records,
			lookup: await describeAddressLayerFile(options.root, files.lookup),
			detail: await describeAddressLayerFile(options.root, files.detail),
			refused: summary.refused,
		}

		await writeLocalJSONFile(
			{ region: entry, build } satisfies USRegionBuildRecord,
			regionBuildRecordPath(options.root, region, options.version)
		)

		builds.push(build)
		options.onState?.(build)

		if (!omitted.has(region)) {
			regions.push(entry)
		}
	}

	if ((options.jobs ?? 1) > 1 && toBuild.length > 1) {
		const counts = await buildStatesInWorkers(
			{ ...options, sortThreads },
			toBuild,
			rowsByState,
			scratch.path,
			(record) => {
				builds.push(record.build)
				options.onState?.(record.build)

				if (!omitted.has(record.region.region)) {
					regions.push(record.region)
				}
			}
		)

		refusedRuns += counts.refusedRuns
		missingRuns += counts.missingRuns
	} else {
		for (const state of toBuild.toSorted()) {
			await buildState(state)
		}
	}

	if (options.writeManifest === false) {
		return { manifest: null, states: builds, refusedRuns, missingRuns }
	}

	// A build of some states keeps the regions an earlier build of this version listed, or,
	// for a version's first build, the regions the base version lists, at that version's paths.
	const existingPath = addressLayerManifestPath(options.root, "US", options.version)

	const basePath = options.baseVersion ? addressLayerManifestPath(options.root, "US", options.baseVersion) : null

	const keptFrom = (await pathExists(existingPath)) ? existingPath : basePath

	if (keptFrom === basePath && basePath && !(await pathExists(basePath))) {
		throw new Error(`the base version ${options.baseVersion} has no manifest at ${basePath}`)
	}

	const kept = keptFrom
		? (await readLocalJSONFile<AddressLayerCountryManifest>(keptFrom)).regions.filter(
				(region) =>
					!builds.some((build) => `us-${build.state.toLowerCase()}` === region.region) && !omitted.has(region.region)
			)
		: []

	const manifest = await writeAddressLayerManifest(options.root, {
		country: "US",
		version: options.version,
		splitRows: ADDRESS_LAYER_SPLIT_ROWS,
		stackLimit: ADDRESS_LAYER_STACK_LIMIT,
		duplicateRule: {
			ranking: US_ADDRESS_SOURCE_RANKING,
			distanceKm: ADDRESS_DUPLICATE_DISTANCE_KM,
			stackLimit: ADDRESS_DUPLICATE_STACK_LIMIT,
		},
		regions: [...kept, ...regions].toSorted((left, right) => left.region.localeCompare(right.region)),
	})

	return { manifest, states: builds, refusedRuns, missingRuns }
}

/**
 * Each worker's V8 heap ceiling.
 *
 * A state's staging lives in SQLite on disk, and the largest state built so far,
 * Florida with 15 million records, peaked at 1.4 GB resident.
 */
const STATE_WORKER_HEAP_MB = 6144

/**
 * Builds `states` in worker processes, at most `options.jobs` at a time,
 * and reports each built region as its worker finishes.
 *
 * States start largest first, by NAD rows plus the planned runs' feature counts,
 * so the longest builds overlap the short ones.
 * The first failure stops new workers from starting, waits for the running ones,
 * and throws with the failed worker's log path.
 */
async function buildStatesInWorkers(
	options: BuildUSAddressLayerOptions,
	states: readonly string[],
	rowsByState: Readonly<Record<string, number>>,
	scratch: PathBuilder,
	onRegion: (record: USRegionBuildRecord) => void
): Promise<USStateWorkerResult> {
	const workerModule = fileURLToPath(import.meta.resolve("#us/address-records/layer-worker"))

	const size = (state: string) =>
		(rowsByState[state] ?? 0) +
		options.openAddresses.plan
			.filter(({ member }) => member.split("/")[1] === state.toLowerCase())
			.reduce((total, { features }) => total + (features ?? 0), 0)

	const queue = states.toSorted((a, b) => size(b) - size(a))
	const counts: USStateWorkerResult = { refusedRuns: 0, missingRuns: 0 }
	const failures: Error[] = []

	// The task file stores the options as JSON, so every path is written as a string.
	const task = (state: string): BuildUSAddressLayerOptions => ({
		root: options.root.toString(),
		version: options.version,
		nadParquet: options.nadParquet.toString(),
		overtureParquet: options.overtureParquet.toString(),
		openAddresses: { plan: options.openAddresses.plan, cache: options.openAddresses.cache.toString() },
		states: [state],
		buildSHA: options.buildSHA,
		adminDatabase: options.adminDatabase.toString(),
		...(typeof options.sortThreads === "number" ? { sortThreads: options.sortThreads } : {}),
	})

	const runOne = async (state: string) => {
		const name = `state-${state.toLowerCase()}`
		const taskPath = scratch(`${name}.task.json`).toString()
		const resultPath = scratch(`${name}.result.json`).toString()
		const logPath = scratch(`${name}.log`).toString()

		await writeLocalJSONFile(task(state), taskPath)

		const log = openWriteStream(logPath, { flags: "a" })

		const child = forkProcess(workerModule, [taskPath, resultPath], {
			execArgv: [`--max-old-space-size=${STATE_WORKER_HEAP_MB}`],
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		})

		child.stdout?.pipe(log, { end: false })
		child.stderr?.pipe(log, { end: false })

		const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
			child.on("error", reject)
			child.on("close", (code, sig) => resolve([code, sig]))
		})

		log.end()

		if (exitCode !== 0) {
			throw new Error(
				`the ${state} worker (pid ${child.pid}) exited with ${signal ? `signal ${signal}` : `code ${exitCode}`}; ` +
					`its log is ${logPath}`
			)
		}

		const result = await readLocalJSONFile<USStateWorkerResult>(resultPath)

		counts.refusedRuns += result.refusedRuns
		counts.missingRuns += result.missingRuns

		const recordPath = regionBuildRecordPath(options.root, `us-${state.toLowerCase()}`, options.version)

		// A state with no NAD rows, Overture rows or admitted runs writes no files and no record.
		if (await pathExists(recordPath)) {
			onRegion(await readLocalJSONFile<USRegionBuildRecord>(recordPath))
		}
	}

	const lanes = Array.from({ length: Math.min(options.jobs ?? 1, queue.length) }, async () => {
		for (let state = queue.shift(); state && !failures.length; state = queue.shift()) {
			try {
				await runOne(state)
			} catch (error) {
				failures.push(error as Error)
			}
		}
	})

	await Promise.all(lanes)

	if (failures.length) throw failures[0]

	return counts
}
