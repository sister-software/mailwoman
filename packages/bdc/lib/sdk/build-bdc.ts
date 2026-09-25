/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { pathExists, readFileRange } from "@mailwoman/core/fs/readers"
import { removePathIfPresent, movePath, makeDirectories, removePath } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import {
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerFreshnessPolicy,
	LayerTier,
	sourcePresentCoverageCells,
	writeLayerCoverage,
	writeLayerManifest,
} from "@mailwoman/core/layers"
import type { FilerDatabase } from "@mailwoman/filer"
import type { FRN } from "@mailwoman/filer/frn"
import type { ProviderListRow } from "@mailwoman/filer/sdk"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { beginBatched } from "@mailwoman/sqlite/batched"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"
import { cellToParent, latLngToCell } from "h3-js"
import type { Insertable, Kysely } from "kysely"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import {
	BDC_COVERAGE_H3_RESOLUTION,
	BDC_H3_RESOLUTION,
	createBDCAvailabilityTable,
	createBDCGeoidIndex,
	createBDCProviderTable,
	type BDCDatabase,
	type BDCProviderTable,
} from "#schema"
import type { ProviderID } from "#sdk/common"
import { readAvailabilityRows, type BDCAvailabilityRow } from "#sdk/parsing"

/**
 * Re-exports the TIGER block centroid helpers that callers use to supply
 * {@link BuildBDCOptions.blockCentroids}, since the geometry module has no package entry point of its own.
 */
export { createTIGERBlockCentroidLookup, geometryCentroid } from "#sdk/geometry"

const STAGE_BATCH_SIZE = 10_000

/**
 * FCC attribution and the required statement that `location_id` is only an opaque join key.
 */
export const BDC_ATTRIBUTION =
	"FCC Broadband Data Collection. This workspace never ingests, ships, or derives data from the Fabric: " +
	"location_id is carried only as an opaque join key that a licensed user may join against their own Fabric copy."

/**
 * Configures {@link buildBDCDatabase}.
 *
 * Rows come from `rows` or from per-provider `csvPaths`, and a block whose centroid
 * `blockCentroids` cannot supply is skipped rather than guessed.
 * `filerDB` is required when `providers` lists a provider ID under more than one FRN,
 * because choosing the primary FRN needs filing data.
 */
export interface BuildBDCOptions {
	/**
	 * An injected row source for tests; when given, `csvPaths` is ignored and nothing is read from disk.
	 */
	rows?: Iterable<BDCAvailabilityRow> | AsyncIterable<BDCAvailabilityRow>

	/**
	 * Per-provider availability CSVs; each file's provider ID is read from its first data row.
	 */
	csvPaths?: string[]

	/**
	 * The `bdc.db` destination, built at `${out}.building` and swapped into place only after sealing.
	 */
	out: PathBuilderLike

	/**
	 * The FCC filing's `as_of_date`, recorded as both the manifest's `version` and its `sourceVintage`.
	 */
	asOfDate: string

	/**
	 * The short git commit hash recorded in the manifest, passed in by the command rather than read here.
	 */
	buildSHA: string

	/**
	 * Whether to populate `bdc_availability.location_id`, default false.
	 *
	 * The column is an opaque join key that is never resolved against the Fabric.
	 * When it is off, rows are deduplicated across locations, so `BuildBDCResult.rows`
	 * counts distinct block and service tuples rather than locations.
	 */
	includeLocationIDs?: boolean

	/**
	 * Resolves a 15-character census block GEOID to its centroid, such as `createTIGERBlockCentroidLookup`.
	 *
	 * It must return `undefined` for an unknown GEOID; the build counts that row in
	 * `unknownGeoids` and skips it rather than guessing a cell.
	 */
	blockCentroids: (geoid: string) => { lat: number; lon: number } | undefined
	onProgress?: (message: string) => void

	/**
	 * Provider-list rows that populate `bdc_provider`, one row per provider ID.
	 */
	providers?: Iterable<ProviderListRow> | AsyncIterable<ProviderListRow>

	/**
	 * The filer database used to choose the primary FRN for a provider ID listed under several FRNs.
	 *
	 * It is queried only for such providers, and the build throws, naming the provider,
	 * when one needs it and it is missing.
	 */
	filerDB?: DatabaseClient<FilerDatabase>

	/**
	 * The date the primary-FRN filing query is scoped to, default `asOfDate`.
	 */
	primaryFRNAsOf?: string
}

/**
 * Summarizes a {@link buildBDCDatabase} run: the output path, rows written, rows removed as
 * duplicates, providers, coverage cells, skipped unknown block GEOIDs and populated provider rows.
 */
export interface BuildBDCResult {
	out: string

	/**
	 * Rows written to `bdc_availability` after deduplication and unknown-GEOID skips.
	 *
	 * Without `includeLocationIDs`, locations in one block that share a provider,
	 * technology, speeds and flags collapse to one row.
	 */
	rows: number

	/**
	 * Input rows dropped as duplicates of the staging natural key.
	 */
	deduped: number

	/**
	 * Distinct provider IDs among the written rows.
	 */
	providers: number

	/**
	 * Resolution-6 coverage cells written.
	 */
	coverageCells: number

	/**
	 * Staged rows skipped because their GEOID had no centroid.
	 */
	unknownGeoids: number

	/**
	 * `bdc_provider` rows written, or 0 when `providers` was not supplied.
	 */
	providersPopulated: number
}

async function createBDCStageTable(db: Kysely<BDCDatabase>): Promise<void> {
	await db.schema
		.createTable("bdc_stage")
		.addColumn("geoid", "text", (c) => c.notNull())
		.addColumn("provider_id", "integer", (c) => c.notNull())
		.addColumn("technology_code", "integer", (c) => c.notNull())
		.addColumn("location_id", "text", (c) => c.notNull())
		.addColumn("max_advertised_download_speed", "integer", (c) => c.notNull())
		.addColumn("max_advertised_upload_speed", "integer", (c) => c.notNull())
		.addColumn("low_latency", "integer", (c) => c.notNull())
		.addColumn("business_residential_code", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("bdc_stage_pk", ["geoid", "provider_id", "technology_code", "location_id"])
		.execute()
}

interface BDCStageRow {
	geoid: string
	provider_id: number
	technology_code: number
	location_id?: string
	max_advertised_download_speed: number
	max_advertised_upload_speed: number
	low_latency: 0 | 1
	business_residential_code: string
}

/**
 * Reads the `provider_id` column from the first data row of an FCC BDC availability CSV,
 * whose rows all share one provider.
 *
 * It throws on a value that is not a safe integer, because `NaN` would bind as NULL,
 * `INSERT OR IGNORE` would drop every row, and the loss would be counted as ordinary deduplication.
 */
export function peekProviderID(csvBuffer: Buffer, csvPath?: string): ProviderID {
	const headerEnd = csvBuffer.indexOf(0x0a)
	const fileSuffix = csvPath ? ` (${csvPath})` : ""

	if (headerEnd === -1) {
		throw new Error(`peekProviderID: no newline found — empty or header-only CSV buffer${fileSuffix}`)
	}

	const nextNewline = csvBuffer.indexOf(0x0a, headerEnd + 1)

	const firstDataLine = csvBuffer
		.subarray(headerEnd + 1, nextNewline === -1 ? undefined : nextNewline)
		.toString("ascii")

	const providerIDField = firstDataLine.split(",")[1]

	if (!providerIDField) {
		throw new Error(`peekProviderID: could not read provider_id (column 1) from the first data row${fileSuffix}`)
	}

	const providerID = Number.parseInt(providerIDField, 10)

	if (!Number.isSafeInteger(providerID)) {
		throw new TypeError(
			`peekProviderID: provider_id column (1) did not parse to a safe integer — got ${stringifyJSON(providerIDField)}` +
				`${fileSuffix}. Refusing to silently drop this file's rows: an unguarded NaN binds to bdc_stage.provider_id ` +
				`(INTEGER NOT NULL) as SQLite NULL, and INSERT OR IGNORE would then discard every row uncounted as ordinary dedup.`
		)
	}

	return providerID as ProviderID
}

const PROVIDER_ID_PEEK_BYTES = 64 * 1024

async function* readAvailabilityRowsFromCSVPaths(csvPaths: readonly string[]): AsyncIterable<BDCAvailabilityRow> {
	for (const csvPath of csvPaths) {
		const providerID = peekProviderID(await readFileRange(csvPath, 0, PROVIDER_ID_PEEK_BYTES), csvPath)

		yield* readAvailabilityRows(csvPath, providerID)
	}
}

const PROVIDER_INSERT_BATCH_SIZE = 500

async function groupProviderListRows(
	providers: Iterable<ProviderListRow> | AsyncIterable<ProviderListRow>
): Promise<Map<number, ProviderListRow[]>> {
	const byProviderID = new Map<number, ProviderListRow[]>()

	for await (const row of providers) {
		const rows = byProviderID.get(row.providerID)

		if (rows) {
			rows.push(row)
		} else {
			byProviderID.set(row.providerID, [row])
		}
	}

	return byProviderID
}

async function populateBDCProviderTable(
	db: DatabaseClient<BDCDatabase>,
	providers: Iterable<ProviderListRow> | AsyncIterable<ProviderListRow>,
	filerDB: DatabaseClient<FilerDatabase> | undefined,
	asOf: string
): Promise<number> {
	const byProviderID = await groupProviderListRows(providers)
	const insertRows: Insertable<BDCProviderTable>[] = []

	let filerSDK: typeof import("@mailwoman/filer/filer-lookup") | undefined

	for (const [providerID, rows] of byProviderID) {
		const distinctFRNs = [...new Set(rows.map((row) => row.frn))]

		let frn: FRN | null

		if (distinctFRNs.length === 1) {
			frn = distinctFRNs[0]!
		} else {
			if (!filerDB) {
				throw new Error(
					`buildBDCDatabase: provider_id ${providerID} carries ${distinctFRNs.length} distinct FRNs across the ` +
						"provider list — resolving the primary FRN (decision 6) requires `filerDB` to be supplied " +
						"alongside `providers`"
				)
			}

			filerSDK ??= await import("@mailwoman/filer/filer-lookup")

			const candidates = await filerSDK.readFRNFilingCandidates(filerDB, distinctFRNs, asOf)

			frn = candidates.length ? filerSDK.pickPrimaryFRN(candidates) : null
		}

		const distinctHoldingCompanies = [
			...new Set(rows.map((row) => row.holdingCompany).filter((value): value is string => value !== null)),
		]

		const holdingCompany = distinctHoldingCompanies.length === 1 ? distinctHoldingCompanies[0]! : null

		insertRows.push({ provider_id: providerID, frn, brand_name: null, holding_company: holdingCompany })
	}

	for (let index = 0; index < insertRows.length; index += PROVIDER_INSERT_BATCH_SIZE) {
		await db
			.insertInto("bdc_provider")
			.values(insertRows.slice(index, index + PROVIDER_INSERT_BATCH_SIZE))
			.execute()
	}

	return insertRows.length
}

/**
 * Build and seal `bdc.db`, then atomically replace the destination.
 */
export async function buildBDCDatabase(options: BuildBDCOptions): Promise<BuildBDCResult> {
	const progress = options.onProgress ?? (() => {})

	if (!options.rows && (!options.csvPaths || !options.csvPaths.length)) {
		throw new Error(
			"buildBDCDatabase: pass either `rows` (test/injected source) or `csvPaths` (per-provider availability CSVs)"
		)
	}

	const buildingPath = `${options.out}.building`

	if (await pathExists(buildingPath)) {
		await removePath(buildingPath)
	}

	const outPath = PathBuilder.from(options.out)
	const outDir = outPath.dirname()

	await makeDirectories(outDir)

	if (!(await pathExists(options.out))) {
		const base = outPath.basename()

		const parked = await Globerator.from("*", { cwd: outDir, absolute: false }).find(
			(name) => name === `${base}.prev` || name.startsWith(`${base}.old-`)
		)

		if (parked) {
			await movePath(outDir(parked), options.out)
			progress(`restored ${parked} into place (a prior run crashed mid-swap)`)
		}
	}

	const rowSource: AsyncIterable<BDCAvailabilityRow> | Iterable<BDCAvailabilityRow> =
		options.rows ?? readAvailabilityRowsFromCSVPaths(options.csvPaths!)

	const db = new DatabaseClient<BDCDatabase>(buildingPath)

	db.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")

	let result: BuildBDCResult

	try {
		progress("creating manifest/coverage/availability/provider/stage tables")
		await createLayerManifestTable(db)
		await createLayerCoverageTable(db)
		await createBDCAvailabilityTable(db)
		await createBDCProviderTable(db)
		await createBDCStageTable(db)

		const insStage = db.prepare(
			`INSERT OR IGNORE INTO bdc_stage (
			geoid, provider_id, technology_code, location_id,
			max_advertised_download_speed, max_advertised_upload_speed, low_latency, business_residential_code
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)

		let staged = 0

		progress("staging rows — raw prepared INSERT OR IGNORE on the natural key (the Redis-dedup replacement)")

		const stageBatch = beginBatched(db, { rowsPerCommit: STAGE_BATCH_SIZE })

		for await (const row of rowSource) {
			insStage.run(
				row.geoid,
				row.provider_id,
				row.technology_code,
				row.location_id,
				row.max_advertised_download_speed,
				row.max_advertised_upload_speed,
				row.low_latency,
				row.business_residential_code
			)

			staged++

			stageBatch.rowWritten()
		}

		stageBatch.commit()

		const stagedCountRow = db.prepare("SELECT COUNT(*) AS staged_count FROM bdc_stage").get() as {
			staged_count: number
		}

		const deduped = staged - stagedCountRow.staged_count

		progress(
			`staged ${stagedCountRow.staged_count.toLocaleString()} distinct row(s), ${deduped.toLocaleString()} deduped`
		)

		const centroidCache = new Map<string, { h3Cell: number; coverageCell: number } | null>()

		const coverage = new Map<number, number>()
		const providers = new Set<number>()
		let unknownGeoids = 0
		let inserted = 0

		const insAvailability = db.prepare(
			`INSERT INTO bdc_availability (
			h3_cell, geoid, wof_id, provider_id, technology_code,
			max_advertised_download_speed, max_advertised_upload_speed, low_latency, business_residential_code, location_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)

		const stageStmt = options.includeLocationIDs
			? db.prepare(
					`SELECT geoid, provider_id, technology_code, location_id,
					max_advertised_download_speed, max_advertised_upload_speed, low_latency, business_residential_code
				 FROM bdc_stage`
				)
			: db.prepare(
					`SELECT DISTINCT geoid, provider_id, technology_code,
					max_advertised_download_speed, max_advertised_upload_speed, low_latency, business_residential_code
				 FROM bdc_stage`
				)

		progress(
			"materializing bdc_availability — resolving block centroids to h3_cell (unknown geoids skipped, never guessed)"
		)

		const materializeBatch = beginBatched(db, { rowsPerCommit: STAGE_BATCH_SIZE })

		for (const row of stageStmt.iterate() as IterableIterator<BDCStageRow>) {
			let resolved = centroidCache.get(row.geoid)

			if (resolved === undefined) {
				const centroid = options.blockCentroids(row.geoid)

				resolved = centroid
					? (() => {
							const fullRes9Cell = latLngToCell(centroid.lat, centroid.lon, BDC_H3_RESOLUTION) as H3Cell

							return {
								h3Cell: shortCellToInt(fullRes9Cell),
								coverageCell: shortCellToInt(cellToParent(fullRes9Cell, BDC_COVERAGE_H3_RESOLUTION) as H3Cell),
							}
						})()
					: null

				centroidCache.set(row.geoid, resolved)
			}

			if (!resolved) {
				unknownGeoids++

				continue
			}

			insAvailability.run(
				resolved.h3Cell,
				row.geoid,

				null,
				row.provider_id,
				row.technology_code,
				row.max_advertised_download_speed,
				row.max_advertised_upload_speed,
				row.low_latency,
				row.business_residential_code,
				options.includeLocationIDs ? (row.location_id ?? null) : null
			)

			inserted++
			providers.add(row.provider_id)
			coverage.set(resolved.coverageCell, (coverage.get(resolved.coverageCell) ?? 0) + 1)

			materializeBatch.rowWritten()
		}

		materializeBatch.commit()

		progress(
			`materialized ${inserted.toLocaleString()} row(s) across ${providers.size} provider(s) ` +
				`(${unknownGeoids.toLocaleString()} unknown geoid(s) skipped)`
		)

		await db.schema.dropTable("bdc_stage").execute()

		progress("geoid index (index-after-load — see schema.ts)")
		await createBDCGeoidIndex(db)

		const coverageCells = sourcePresentCoverageCells(coverage)

		await writeLayerCoverage(db, coverageCells)

		progress("writing layer manifest")

		await writeLayerManifest(db, {
			name: "bdc",
			version: options.asOfDate,
			schemaVersion: 1,
			tier: LayerTier.Shipped,
			license: "LicenseRef-USGov-Public-Domain",
			attribution: BDC_ATTRIBUTION,
			source: "fcc-bdc",
			sourceVintage: options.asOfDate,
			buildCmd: "mailwoman gazetteer build bdc",
			buildSHA: options.buildSHA,
			freshnessPolicy: LayerFreshnessPolicy.VersionedRefresh,
			spineKeys: { h3: { column: "h3_cell", resolution: BDC_H3_RESOLUTION }, wofID: "wof_id" },
			createdAt: new Date().toISOString(),
		})

		let providersPopulated = 0

		if (options.providers) {
			progress("populating bdc_provider from the provider list (decision 6 — lossy denormalization, see schema.ts)")

			providersPopulated = await populateBDCProviderTable(
				db,
				options.providers,
				options.filerDB,
				options.primaryFRNAsOf ?? options.asOfDate
			)

			progress(`bdc_provider: ${providersPopulated.toLocaleString()} provider(s) populated`)
		}

		progress("finalize: ANALYZE + VACUUM")
		db.exec("ANALYZE")

		db.exec("PRAGMA page_size=8192")
		db.exec("VACUUM")
		await db.destroy()

		result = {
			out: outPath.toString(),
			rows: inserted,
			deduped,
			providers: providers.size,
			coverageCells: coverageCells.length,
			unknownGeoids,
			providersPopulated,
		}
	} catch (error) {
		try {
			await db.destroy()
		} catch {}

		await removePathIfPresent(buildingPath)

		throw error
	}

	progress("seal")
	await sealDatabase(buildingPath)

	await swapDatabaseIntoPlace(buildingPath, options.out)

	return result
}
