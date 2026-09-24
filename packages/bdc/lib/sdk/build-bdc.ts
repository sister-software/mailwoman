/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Build a sealed FCC BDC database from availability rows. Staging deduplicates natural keys;
 * default materialization collapses rows differing only by `location_id`. Coverage is aggregated
 * during materialization. The sealed build replaces the previous artifact only on success.
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
// Runtime filer helpers are imported only when provider population needs them.
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

export { createTIGERBlockCentroidLookup, geometryCentroid } from "#sdk/geometry"

/**
 * Rows committed per batch during staging and materialization.
 */
const STAGE_BATCH_SIZE = 10_000

/**
 * FCC attribution and the required statement that `location_id` is only an opaque join key.
 */
export const BDC_ATTRIBUTION =
	"FCC Broadband Data Collection. This workspace never ingests, ships, or derives data from the Fabric: " +
	"location_id is carried only as an opaque join key that a licensed user may join against their own Fabric copy."

export interface BuildBDCOptions {
	/**
	 * Injected row source — the test injection point (mirrors `BuildPOIOptions.rows`).
	 *
	 * When given, `csvPaths` is ignored and no filesystem read happens.
	 */
	rows?: Iterable<BDCAvailabilityRow> | AsyncIterable<BDCAvailabilityRow>
	/**
	 * State availability CSVs, ignored when `rows` is supplied, provide IDs in their first data rows.
	 */
	csvPaths?: string[]
	/**
	 * Output `bdc.db` path.
	 *
	 * Built at `${out}.building` and moved into place last — see the module docstring.
	 */
	out: PathBuilderLike
	/**
	 * The FCC filing's `as_of_date` (e.g. From `resolveLatestVintage`) — becomes the
	 * manifest's `sourceVintage` and `version` (BDC has no independent layer versioning
	 * yet, same deferral `build-poi.ts` makes for `release`).
	 */
	asOfDate: string
	/**
	 * `git rev-parse --short head` — passed in by the command rather than read from the repo here.
	 */
	buildSHA: string
	/**
	 * Populate `bdc_availability.location_id` (the opaque BSL join key — spec §2.2,
	 * never resolved against the Fabric).
	 *
	 * Default `false`: the column stays `NULL` unless a caller explicitly opts in.
	 */
	includeLocationIDs?: boolean
	/**
	 * Resolve a 15-char census block geoid to its centroid.
	 *
	 * Injected so tests supply a small fixture `Map` lookup instead of touching a real tiger database.
	 * The real (CLI-wired) implementation is {@linkcode createTIGERBlockCentroidLookup},
	 * which reads `tabblock20.geoid` (uppercase — `TIGERBlockTable`) block geometry.
	 *
	 * Returning `undefined` for an unknown geoid is required: the materialize pass
	 * counts it in `unknownGeoids` and skips the row.
	 * It must never guess a cell.
	 */
	blockCentroids: (geoid: string) => { lat: number; lon: number } | undefined
	onProgress?: (message: string) => void
	/**
	 * Optional provider-list rows populate `bdc_provider`, grouped by `providerID`.
	 */
	providers?: Iterable<ProviderListRow> | AsyncIterable<ProviderListRow>
	/**
	 * Filer.db handle (`@mailwoman/filer`) used to resolve a multi-FRN provider's primary FRN
	 * via `readFRNFilingCandidates` + `pickPrimaryFRN` (`@mailwoman/filer/sdk`, decision 6) —
	 * imported rather than reimplemented, because the candidate query needs both halves
	 * of the half-open `valid_from`/`valid_to` predicate and a second implementation
	 * here would be a second place to drop the `valid_to` half.
	 *
	 * Only actually queried for a `provider_id` whose rows carry more than one distinct `frn`.
	 * A single-FRN provider needs no lookup, since its lone FRN is already primary by construction.
	 *
	 * Required whenever `providers` is given and at least one `provider_id` turns out to
	 * be multi-FRN; `buildBDCDatabase` throws a descriptive error naming the offending
	 * `provider_id` if it's needed but missing, rather than silently picking an arbitrary FRN.
	 */
	filerDB?: DatabaseClient<FilerDatabase>
	/**
	 * `asOf` date for the primary-FRN candidate query (`readFRNFilingCandidates`'s half-open
	 * `valid_from`/`valid_to` scoping — see `filer/sdk/filer-lookup.ts`).
	 *
	 * Defaults to {@link BuildBDCOptions.asOfDate} (this bdc.db build's own vintage) when omitted.
	 */
	primaryFRNAsOf?: string
}

export interface BuildBDCResult {
	out: string
	/**
	 * Rows materialized into `bdc_availability` (post-dedup, post-unknown-geoid-skip).
	 *
	 * In the default (`includeLocationIDs: false`) mode this is per distinct
	 * (geoid, provider_id, technology_code, speeds, low_latency, business_residential_code) tuple
	 * rather than per BSL — multiple BSLs at the same (geoid, provider_id, technology_code)
	 * triple collapse to one row only when their speeds/flags also match.
	 * BSLs at the same triple with differing speeds/flags survive as separate rows (see the module docstring).
	 */
	rows: number
	/**
	 * Raw rows removed by the staging natural-key dedup (staged attempts minus distinct rows kept).
	 */
	deduped: number
	/**
	 * Distinct `provider_id` values among the materialized rows.
	 */
	providers: number
	/**
	 * Res-6 coverage cells written.
	 */
	coverageCells: number
	/**
	 * Rows whose `geoid` had no resolvable centroid — skipped, never inserted, never guessed at a cell.
	 */
	unknownGeoids: number
	/**
	 * `bdc_provider` rows written — 0 when `options.providers` was not supplied
	 * (the default path never touches this table, see {@link BuildBDCOptions.providers}).
	 */
	providersPopulated: number
}

/**
 * Create the build-only `bdc_stage` table — deliberately not part of the public {@link BDCDatabase}
 * interface (it's dropped before the artifact seals, so it never appears in the shipped schema).
 *
 * Built via Kysely's schema builder per the agents.md DDL convention
 * (`createTable` takes any string table name — it doesn't need to be a `keyof DB` to type-check);
 * all of `bdc_stage`'s actual reads/writes below go through raw `.prepare()` on the
 * shared `DatabaseSync` instead, per the "hot bulk write" carve-out.
 *
 * The composite primary KEY on the natural key is what makes `insert or ignore` a dedup: SQLite
 * silently drops any insert whose key already exists rather than raising the constraint violation.
 */
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

/**
 * A `bdc_stage` row, as read back by the materialize pass.
 *
 * When `includeLocationIDs` is true, `location_id` is populated (one row per distinct BSL).
 * When false (default), the materialize query collapses on every column
 * except `location_id` (see {@linkcode buildBDCDatabase}'s materialize step),
 * so `location_id` is simply absent from that query and never read.
 */
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
 * Peek the constant `provider_id` column (index 1) off an FCC BDC availability CSV's first data row.
 *
 * Production per-provider files carry the same `provider_id` in every row
 * (the FCC partitions availability files per provider).
 * `parsing.ts`'s `takeAvailabilityLine` already assumes this, taking `providerID`
 * as a parameter rather than re-slicing column 1 per row.
 *
 * This reads it once, directly off the raw bytes, rather than threading a parallel
 * `providerID` array alongside `csvPaths` through the public options shape.
 *
 * `csvPath` is optional and used only to name the offending file in a thrown error (the direct-buffer
 * unit tests call this without one; {@linkcode readAvailabilityRowsFromCSVPaths} always supplies it).
 * The `Number.isSafeInteger` guard below is required rather than defensive dressing:
 * `bdc_stage.provider_id` is `integer not NULL`, and a bare `Number.parseInt` on a
 * non-numeric field (a malformed/re-headered/truncated CSV) silently produces `NaN`.
 *
 * `NaN` binds to that not NULL column as SQLite `NULL`, `insert or ignore` then drops
 * the row without a constraint error, and every dropped row gets counted as `deduped` —
 * the entire file's rows vanish silently, misreported as ordinary dedup.
 * A malformed CSV must be loud, never silently absorbed, so this throws instead.
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

/**
 * Bytes read to peek the `provider_id`.
 *
 * Only the header row plus the first data row are needed and an FCC availability row
 * is ~110 bytes, so this is three orders of magnitude of slack.
 * A file shorter than this simply reads short — {@linkcode peekProviderID} already
 * reports a header-only or empty file by message.
 *
 * `provider_id` is a constant per file, so establishing it needs the first data row and nothing else.
 * A whole-file read was resident-loading 920 MB (one state × technology) to read one column of one row.
 */
const PROVIDER_ID_PEEK_BYTES = 64 * 1024

/**
 * Peeks each file's `provider_id` off its head ({@linkcode peekProviderID}, passing the path through
 * so a malformed file's error names it), then streams every row via `readAvailabilityRows`.
 * The file is never resident.
 *
 * This is the production counterpart to the test injection point's injected `rows` —
 * exercised by `build-bdc.test.ts` only for the malformed-provider-id rejection path,
 * same as `build-poi.ts`'s Parquet reader.
 */
async function* readAvailabilityRowsFromCSVPaths(csvPaths: readonly string[]): AsyncIterable<BDCAvailabilityRow> {
	for (const csvPath of csvPaths) {
		const providerID = peekProviderID(await readFileRange(csvPath, 0, PROVIDER_ID_PEEK_BYTES), csvPath)

		yield* readAvailabilityRows(csvPath, providerID)
	}
}

/**
 * Rows per `insert` batch when populating `bdc_provider`.
 *
 * Far smaller than {@link STAGE_BATCH_SIZE}: that constant tunes `bdc_availability`'s
 * multi-million-row raw-prepared-statement path, whereas `bdc_provider` is a small per-provider
 * dictionary (thousands of rows rather than millions) inserted through Kysely's typed `insertInto`.
 * This batches only to stay comfortably under SQLite's bound-parameter ceiling rather than for throughput.
 */
const PROVIDER_INSERT_BATCH_SIZE = 500

/**
 * Groups `providers` by `providerID`.
 *
 * `parseProviderList` yields one {@link ProviderListRow} PER line of the source CSV, preserving
 * cardinality (never folded, never last-wins — see that module's docstring) — so a `provider_id`
 * appearing on N rows arrives here as N separate rows, exactly as decision 6 requires downstream.
 */
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

/**
 * Populate `bdc_provider` from `options.providers` (2a decision 8 / 3a decision 6).
 *
 * See `schema.ts`'s `BDCProviderTable` docstring for the full lossy-denormalization rationale.
 *
 * For each distinct `provider_id`:
 *
 * - Exactly one `frn` among its rows → that FRN is primary by construction.
 *   No `filerDB` query needed at all.
 * - More than one distinct `frn` → `readFRNFilingCandidates`
 *   (`@mailwoman/filer/sdk`, lazily imported — see below) reads each FRN's own most
 *   recent IN-force `form-499` filing edge from `filerDB`, `asOf` the given date,
 *   and `pickPrimaryFRN` picks the winner (decision 6: most recent 499 filing date wins).
 *   A `provider_id` whose FRNs carry no 499 filing to rank by inserts `frn: NULL` rather than
 *   guessing — `pickPrimaryFRN` throws on empty input, so this checks `candidates.length` first,
 *   mirroring `filerLookup`'s own `primary_frn: null` handling of the same case.
 * - `filerDB` is required the instant a multi-FRN `provider_id` is encountered.
 *   Its absence throws immediately, naming the offending `provider_id`,
 *   rather than silently picking an arbitrary FRN.
 * - `holding_company` gets the identical single-distinct-value shortcut `frn` gets:
 *   exactly one distinct non-null `holdingCompany` across a provider's rows means there's
 *   no conflict to resolve, so it's populated directly, no rule needed.
 *   Two or more distinct values is the real conflict decision 6 refuses to paper over with last-wins.
 *   That case inserts NULL, and every value stays recoverable from `filer.db`.
 *   A `null` `holdingCompany` on some rows doesn't count as a competing
 *   value (a row simply not stating it isn't a conflicting assertion) —
 *   only distinct NON-NULL strings are compared.
 *
 * `brand_name` is always inserted NULL.
 * The provider list carries no brand-name column at all, so there is nothing to
 * populate it from, primary or otherwise (see the schema docstring).
 *
 * **Lazy `@mailwoman/filer/filer-lookup` import.** `readFRNFilingCandidates`/`pickPrimaryFRN`
 * are loaded via `await import("@mailwoman/filer/filer-lookup")`, memoized in
 * `filerSDK` below, rather than a top-level static import.
 * The cost this avoids is smaller than it was: the specifier used to be the
 * `@mailwoman/filer/sdk` barrel, which `export *`s `cluster-filers.ts` and
 * so pulls `@mailwoman/match`/`record`/`registry` in behind it.
 *
 * A top-level import of that barrel regressed `@mailwoman/bdc`'s import time ~32% for
 * every consumer, including ones that never populate providers.
 * `filer-lookup.ts` alone imports only `@mailwoman/sqlite/client`, `#schema`
 * and `#frn` (measured 2026-09-01), so the heavy graph is no longer on this path at all.
 *
 * The laziness is kept because it also defers opening the filer database,
 * and a static import here is now a viable simplification if someone wants to measure it,
 * but it is no longer required for import time.
 */
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

	// Restore an artifact left aside by an interrupted swap before starting another build.
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
	// Apply the database build settings used by other large extract builders.
	db.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")

	// Keep build tallies in scope for result creation after the load completes.
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
		/**
		 * Observed row counts by res-6 coverage cell.
		 */
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

		// Keep each BSL when IDs are requested.
		// Otherwise, collapse rows that differ only by ID; retain rows with different speeds or service fields.
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
							// Derive coverage from the stored res-9 cell so the reader gets the same parent.
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
				// WOF IDs are added by a separate registry-join step.
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

		// Record cells with source rows as covered; absent cells remain unknown.
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

		// Populate the optional provider table only when provider rows were supplied.
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
		// VACUUM applies the configured page size to the database file.
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
		// Close the handle and remove the temporary file without masking the build error.
		try {
			await db.destroy()
		} catch {
			// Cleanup can fail if the handle is already closed or executing a statement.
		}

		await removePathIfPresent(buildingPath)

		throw error
	}

	progress("seal")
	await sealDatabase(buildingPath)

	// The shared helper preserves the previous version and restores it if the swap fails.
	await swapDatabaseIntoPlace(buildingPath, options.out)

	return result
}
