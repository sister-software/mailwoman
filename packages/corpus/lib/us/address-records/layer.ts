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
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { extractZipEntry } from "@mailwoman/core/fs/zip"
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
import { resolvePath, type PathBuilder, type PathBuilderLike } from "path-ts"

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
 * One OpenAddresses run as a plan lists it, with the license its source definition records.
 */
export interface OpenAddressesPlanEntry {
	member: string
	license: unknown
	skip?: boolean
}

export interface BuildUSAddressLayerOptions {
	/**
	 * The data root's `db` directory, under which `addresses/<region>/<version>/` is written.
	 */
	root: PathBuilderLike
	version: string
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
	onState?: (summary: USStateBuild) => void
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
	manifest: PathBuilder
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
 * The US layer's source ranking, highest first: NAD, then OpenAddresses runs
 * read directly, then Overture's datasets.
 *
 * Overture's datasets rank last because most are copies of OpenAddresses runs from an earlier release.
 */
export const US_ADDRESS_SOURCE_RANKING = ["usgov-nad", "openaddresses:*", "overture:*"] as const

/**
 * A source id's place in {@linkcode US_ADDRESS_SOURCE_RANKING}, lowest first.
 */
export function usAddressSourceRank(source: string): number {
	if (source === "usgov-nad") return 0

	if (source.startsWith("openaddresses:")) return 1

	if (source.startsWith("overture:")) return 2

	return 3
}

const US_DUPLICATE_RULE: AddressDuplicateRule = {
	rank: usAddressSourceRank,
	unitIdentifier: (unit, context) => usUnitIdentifier(unit, context),
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
 * Rows that several sources hold for one address stay one record per source.
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

	const omitted = new Set(options.omitFromManifest)
	const recorded = recordedRunTerms(options.openAddresses.plan)
	const units = await createUnitSplitter()

	using bounds = openSubdivisionBoundsCheck(options.adminDatabase)
	const regions: AddressLayerCountryManifest["regions"] = []
	const builds: USStateBuild[] = []
	let refusedRuns = 0
	let missingRuns = 0

	await using scratch = await temporaryDirectory("us-address-layer-")

	for (const state of states.toSorted()) {
		const region = `us-${state.toLowerCase()}`
		const files = addressLayerFiles(options.root, region, options.version)
		const hasNAD = (rowsByState[state] ?? 0) > 0
		const datasets = await overtureDatasets(options.overtureParquet, state)
		const runs: string[] = []

		for (const { member, license, skip } of options.openAddresses.plan) {
			if (member.split("/")[0] !== "us" || member.split("/")[1] !== state.toLowerCase() || skip) continue

			if (!isAdmittedSource(member, license)) {
				refusedRuns++
			} else if (await cachedRun(options.openAddresses.cache, member)) {
				runs.push(member)
			} else {
				missingRuns++
			}
		}

		if (!hasNAD && !datasets.length && !runs.length) continue

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
			refuseRecord: (record) => bounds.refuse(record),
			duplicates: US_DUPLICATE_RULE,
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

		builds.push(build)
		options.onState?.(build)

		if (!omitted.has(region)) {
			regions.push({
				region,
				subdivision: `US-${state}`,
				records: summary.records,
				lookup: await describeAddressLayerFile(options.root, files.lookup),
				detail: await describeAddressLayerFile(options.root, files.detail),
				refused: summary.refused,
			})
		}
	}

	// A build of some states keeps the regions an earlier build of this version listed.
	const existingPath = addressLayerManifestPath(options.root, "US", options.version)

	const kept = (await pathExists(existingPath))
		? (await readLocalJSONFile<AddressLayerCountryManifest>(existingPath)).regions.filter(
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
