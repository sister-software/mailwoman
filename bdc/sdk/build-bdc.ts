/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `bdc.db` builder (2a Task 8) — ingests parsed FCC BDC availability rows (Task 6's
 *   {@link BDCAvailabilityRow}) into Task 7's schema (`schema.ts`), producing a sealed layer database.
 *
 *   Mirrors `mailwoman/gazetteer-pipeline/poi/build-poi.ts`'s shape closely: the same build-tuning
 *   pragmas, the same single-pass `Map<number, number>` coverage aggregation taken during the load
 *   (no second scan), the same {@link asContractDB} Kysely-invariance cast for the shared
 *   `@mailwoman/core/layers` calls, and the same `writeLayerManifest` → `sealDatabase` tail.
 *
 *   Two differences from that precedent, both deliberate:
 *
 *   1. **A staging-dedup pass.** BDC's per-provider CSVs can carry exact-duplicate rows (repeat
 *      filings, overlapping re-downloads); poi's Overture rows never needed this. `bdc_stage` is a
 *      plain Kysely-built table (not part of the public {@link BDCDatabase} — it never survives to the
 *      sealed artifact) carrying a composite PRIMARY KEY on the natural key
 *      `(geoid, provider_id, technology_code, location_id)`. Rows load via a RAW prepared
 *      `INSERT OR IGNORE` — the AGENTS.md "hot bulk write" carve-out, same discipline as the
 *      candidate-gazetteer builder — which is the direct replacement for the Redis
 *      set-membership check Nexus's `sync/commands/bdc/infer-locations.ts` used for this exact
 *      dedup (dedup semantics only; Nexus's Redis-backed location inference itself has no analog
 *      here). `h3_cell` is computed only AFTER staging, per distinct geoid, against the deduped set —
 *      so a duplicate row is never charged twice against `unknownGeoids` or `layer_coverage` either.
 *      The natural key's `location_id` component means the SAME (geoid, provider_id, technology_code)
 *      triple legitimately survives staging once per distinct BSL — correct when `includeLocationIDs`
 *      is true. The default (NULL `location_id`) mode collapses at MATERIALIZE time via `SELECT DISTINCT`
 *      over every column EXCEPT `location_id` — that is, to one row per distinct (geoid, provider_id,
 *      technology_code, max_advertised_download_speed, max_advertised_upload_speed, low_latency,
 *      business_residential_code) TUPLE, NOT one row per (geoid, provider_id, technology_code) triple.
 *      When every BSL in a block shares identical speeds/flags for a given provider/technology (the
 *      common case), those two are the same thing and the collapse yields exactly one row per triple.
 *      But when BSLs at the SAME triple carry DIFFERENT speeds/flags (a real, accepted FCC filing
 *      pattern — a provider filing different advertised speeds at different addresses in one block),
 *      the distinct rows survive collapse as multiple NULL-`location_id` rows at that one triple. This
 *      is deliberate, matches the FCC source data's own granularity, and is NOT a bug to fix — see
 *      `filing-landscape.ts`'s module docstring for the read-side consequence (the same provider/tech
 *      can surface in more than one `speed_bucket` for one queried block).
 *   2. **Temp-path build + move-aside-first swap**, per AGENTS.md's database house rule ("build
 *      successfully, then move the previous version to a temp directory, and then move the new
 *      version into place... ensures the database is always in a consistent state, even if the build
 *      script fails halfway through"): build lands at `${out}.building`, seals there, then
 *      `${out}` (if present) is renamed to `${out}.prev` BEFORE the sealed build takes its place —
 *      mirroring `mailwoman/eval-harness/gauntlet/build-regression-db.ts`'s swap. `build-poi.ts`
 *      instead writes `out` directly (removing any stale file first) and records ITS OWN deviation
 *      from an even older staging-suffix convention — see that file's docstring. This builder takes
 *      the opposite fork on purpose: a from-scratch nationwide BDC ingest is long enough that a
 *      mid-build crash mustn't cost the previously-good artifact, which is exactly the failure mode
 *      the house rule exists for.
 */

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import {
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerFreshnessPolicy,
	LayerTier,
	writeLayerCoverage,
	writeLayerManifest,
	type LayerContractDatabase,
} from "@mailwoman/core/layers"
import { openBuiltDatabase, sealDatabase } from "@mailwoman/core/utils"
import type { FilerDatabase } from "@mailwoman/filer"
import { pickPrimaryFRN, readFRNFilingCandidates, type FRN, type ProviderListRow } from "@mailwoman/filer/sdk"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { cellToParent, latLngToCell } from "h3-js"
import type { Insertable, Kysely } from "kysely"

import {
	BDC_COVERAGE_H3_RESOLUTION,
	BDC_H3_RESOLUTION,
	createBDCAvailabilityTable,
	createBDCGeoidIndex,
	createBDCProviderTable,
	type BDCDatabase,
	type BDCProviderTable,
} from "../schema.ts"
import type { ProviderID } from "./common.ts"
import { takeAvailabilityLine, type BDCAvailabilityRow } from "./parsing.ts"

/**
 * Rows committed per `BEGIN`/`COMMIT` batch during both the staging load and the materialize pass — matches
 * `build-poi.ts`'s `STAGE_BATCH_SIZE` discipline.
 */
const STAGE_BATCH_SIZE = 10_000

/**
 * The manifest's `attribution` — names the FCC as the source, then copies the Fabric-boundary sentence verbatim from
 * `bdc/README.md`'s "CostQuest Fabric boundary" section (backticks stripped — this is plain prose, not markdown).
 */
export const BDC_ATTRIBUTION =
	"FCC Broadband Data Collection. This workspace never ingests, ships, or derives data from the Fabric: " +
	"location_id is carried only as an opaque join key that a licensed user may join against their own Fabric copy."

export interface BuildBDCOptions {
	/**
	 * Injected row source — the test seam (mirrors `BuildPOIOptions.rows`). When given, `csvPaths` is ignored and no
	 * filesystem read happens.
	 */
	rows?: Iterable<BDCAvailabilityRow> | AsyncIterable<BDCAvailabilityRow>
	/**
	 * Per-provider availability CSVs for one state (as extracted by `downloadBDCFile`). Ignored when `rows` is given.
	 * Required unless `rows` is given. Each file's constant `provider_id` column is peeked off its first data row (see
	 * {@linkcode peekProviderID}) rather than threaded through as a parallel array — the FCC's per-provider files already
	 * carry it once per file, redundantly, in column 1.
	 */
	csvPaths?: string[]
	/**
	 * Output `bdc.db` path. Built at `${out}.building` and moved into place last — see the module docstring.
	 */
	out: string
	/**
	 * The FCC filing's `as_of_date` (e.g. from Task 5's `resolveLatestVintage`) — becomes the manifest's `sourceVintage`
	 * AND `version` (BDC has no independent layer versioning yet, same deferral `build-poi.ts` makes for `release`).
	 */
	asOfDate: string
	/**
	 * `git rev-parse --short HEAD` — passed in by the command, not read from the repo here.
	 */
	buildSHA: string
	/**
	 * Populate `bdc_availability.location_id` (the opaque BSL join key — spec §2.2, NEVER resolved against the Fabric).
	 * Default `false`: the column stays `NULL` unless a caller explicitly opts in.
	 */
	includeLocationIDs?: boolean
	/**
	 * Resolve a 15-char census block GEOID to its centroid. Injected so tests supply a small fixture `Map` lookup instead
	 * of touching a real TIGER database; the real (CLI-wired) implementation is
	 * {@linkcode createTIGERBlockCentroidLookup}, which reads `tabblock20.GEOID` (uppercase — `TIGERBlockTable`) block
	 * geometry. Returning `undefined` for an unknown geoid is load-bearing: the materialize pass counts it in
	 * `unknownGeoids` and skips the row — it must NEVER guess a cell.
	 */
	blockCentroids: (geoid: string) => { lat: number; lon: number } | undefined
	onProgress?: (message: string) => void
	/**
	 * Provider-list rows (Task 3's {@link ProviderListRow}, `@mailwoman/filer/sdk`'s `parseProviderList`) — the test/CLI
	 * seam for populating `bdc_provider` (2a decision 8 / 3a decision 6, Task 8). When ABSENT (the default),
	 * `bdc_provider` stays empty and the rest of the build is byte-identical to the pre-Task-8 behavior: every code path
	 * this option touches is gated behind `if (options.providers)`, so omitting it changes nothing. When present,
	 * `buildBDCDatabase` groups rows by `providerID` and inserts one `bdc_provider` row per distinct provider — see
	 * {@link BuildBDCOptions.filerDB} for how the primary FRN is picked when a provider carries more than one, and
	 * `schema.ts`'s `BDCProviderTable` docstring for the full lossy-denormalization rationale (decision 6).
	 */
	providers?: Iterable<ProviderListRow> | AsyncIterable<ProviderListRow>
	/**
	 * Filer.db handle (`@mailwoman/filer`) used to resolve a multi-FRN provider's PRIMARY FRN via
	 * `readFRNFilingCandidates` + `pickPrimaryFRN` (`@mailwoman/filer/sdk`, decision 6) — imported rather than
	 * reimplemented, since Task 7's review found and fixed a temporal bug (the candidate query originally omitted the
	 * `valid_to` half of the half-open predicate) that a fresh implementation here would reintroduce. Only actually
	 * QUERIED for a `provider_id` whose rows carry more than one distinct `frn` — a single-FRN provider needs no lookup,
	 * since its lone FRN is already primary by construction. Required whenever `providers` is given AND at least one
	 * `provider_id` turns out to be multi-FRN; `buildBDCDatabase` throws a descriptive error naming the offending
	 * `provider_id` if it's needed but missing, rather than silently picking an arbitrary FRN.
	 */
	filerDB?: DatabaseClient<FilerDatabase>
	/**
	 * `asOf` date for the primary-FRN candidate query (`readFRNFilingCandidates`'s half-open `valid_from`/`valid_to`
	 * scoping — see `filer/sdk/filer-lookup.ts`). Defaults to {@link BuildBDCOptions.asOfDate} (this bdc.db build's own
	 * vintage) when omitted.
	 */
	primaryFRNAsOf?: string
}

export interface BuildBDCResult {
	out: string
	/**
	 * Rows materialized into `bdc_availability` (post-dedup, post-unknown-geoid-skip). In the default
	 * (`includeLocationIDs: false`) mode this is per DISTINCT (geoid, provider_id, technology_code, speeds, low_latency,
	 * business_residential_code) tuple, not per BSL — multiple BSLs at the same (geoid, provider_id, technology_code)
	 * triple collapse to one row ONLY when their speeds/flags also match; BSLs at the same triple with differing
	 * speeds/flags survive as separate rows (see the module docstring).
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
	 * `bdc_provider` rows written — 0 when `options.providers` was not supplied (the default path never touches this
	 * table, see {@link BuildBDCOptions.providers}).
	 */
	providersPopulated: number
}

/**
 * `BDCDatabase extends LayerContractDatabase` structurally, but Kysely's `transaction()` makes `Kysely<DB>` INVARIANT
 * in `DB` — narrows a `DatabaseClient<BDCDatabase>` handle back down for the `@mailwoman/core/layers` calls. Exact
 * precedent: `build-poi.ts`'s own `asContractDB`; see that file for the full rationale (tried widening the shared
 * package's signatures first — breaks THEIR internal `insertInto`/`selectFrom` calls instead).
 */
function asContractDB(kdb: DatabaseClient<BDCDatabase>): DatabaseClient<LayerContractDatabase> {
	return kdb as unknown as DatabaseClient<LayerContractDatabase>
}

/**
 * Create the build-only `bdc_stage` table — deliberately NOT part of the public {@link BDCDatabase} interface (it's
 * dropped before the artifact seals, so it never appears in the shipped schema). Built via Kysely's schema builder per
 * the AGENTS.md DDL convention (`createTable` takes any string table name — it doesn't need to be a `keyof DB` to
 * type-check); all of `bdc_stage`'s actual reads/writes below go through raw `.prepare()` on the shared `DatabaseSync`
 * instead, per the "hot bulk write" carve-out.
 *
 * The composite PRIMARY KEY on the natural key is what makes `INSERT OR IGNORE` a dedup: SQLite silently drops any
 * insert whose key already exists rather than raising the constraint violation.
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
 * A `bdc_stage` row, as read back by the materialize pass. When `includeLocationIDs` is true, `location_id` is
 * populated (one row per distinct BSL). When false (default), the materialize query collapses on every column EXCEPT
 * `location_id` (see {@linkcode buildBDCDatabase}'s materialize step), so `location_id` is simply absent from that
 * query and never read.
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
 * Production per-provider files carry the SAME `provider_id` in every row (the FCC partitions availability files per
 * provider) — `parsing.ts`'s `takeAvailabilityLine` already assumes this, taking `providerID` as a parameter rather
 * than re-slicing column 1 per row. This reads it once, directly off the raw bytes, rather than threading a parallel
 * `providerID` array alongside `csvPaths` through the public options shape.
 *
 * `csvPath` is optional and used ONLY to name the offending file in a thrown error (the direct-buffer unit tests call
 * this without one; {@linkcode readAvailabilityRowsFromCSVPaths} always supplies it). The `Number.isSafeInteger` guard
 * below is load-bearing, not defensive dressing: `bdc_stage.provider_id` is `INTEGER NOT NULL`, and a bare
 * `Number.parseInt` on a non-numeric field (a malformed/re-headered/truncated CSV) silently produces `NaN`. `NaN` binds
 * to that NOT NULL column as SQLite `NULL`, `INSERT OR IGNORE` then drops the row without a constraint error, and every
 * dropped row gets counted as `deduped` — the ENTIRE file's rows vanish silently, misreported as ordinary dedup. A
 * malformed CSV must be loud, never silently absorbed, so this throws instead.
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
			`peekProviderID: provider_id column (1) did not parse to a safe integer — got ${JSON.stringify(providerIDField)}` +
				`${fileSuffix}. Refusing to silently drop this file's rows: an unguarded NaN binds to bdc_stage.provider_id ` +
				`(INTEGER NOT NULL) as SQLite NULL, and INSERT OR IGNORE would then discard every row uncounted as ordinary dedup.`
		)
	}

	return providerID as ProviderID
}

/**
 * Reads each of `csvPaths` fully into memory, peeks its `provider_id` ({@linkcode peekProviderID}, passing the path
 * through so a malformed file's error names it), then yields every row via `takeAvailabilityLine`. This is the
 * production counterpart to the test seam's injected `rows` — exercised by `build-bdc.test.ts` only for the
 * malformed-provider-id rejection path, same as `build-poi.ts`'s `readParquetRows`.
 */
async function* readAvailabilityRowsFromCSVPaths(csvPaths: readonly string[]): AsyncIterable<BDCAvailabilityRow> {
	for (const csvPath of csvPaths) {
		const buffer = await readFile(csvPath)
		const providerID = peekProviderID(buffer, csvPath)

		yield* takeAvailabilityLine(buffer, providerID)
	}
}

/**
 * One GeoJSON `Polygon`/`MultiPolygon` geometry, as stored in `tabblock20.geometry` (see `tiger/sdk/schema.ts`).
 */
interface GeoJSONPolygon {
	type: "Polygon"
	coordinates: number[][][]
}

interface GeoJSONMultiPolygon {
	type: "MultiPolygon"
	coordinates: number[][][][]
}

/**
 * Naive (vertex-average, NOT area-weighted) centroid of a GeoJSON `Polygon`/`MultiPolygon`'s EXTERIOR ring(s) only
 * (interior rings/holes are ignored). A known simplification, not an oversight: census blocks are small relative to a
 * res-9 H3 cell (~174m edge), so the vertex-average and a proper area-weighted centroid land in the same cell for all
 * but pathologically elongated or holed block shapes. A precise area-weighted centroid is a reasonable future upgrade
 * if that ever proves wrong in practice — no polygon-centroid library is pulled in for this first cut.
 *
 * Returns `undefined` for anything that doesn't parse as one of the two geometry types (including `null` geometry).
 */
export function geometryCentroid(geometryJSON: string | null): { lat: number; lon: number } | undefined {
	if (!geometryJSON) return undefined

	let geometry: GeoJSONPolygon | GeoJSONMultiPolygon

	try {
		geometry = JSON.parse(geometryJSON)
	} catch {
		return undefined
	}

	const exteriorRings: number[][][] =
		geometry.type === "Polygon"
			? [geometry.coordinates[0] ?? []]
			: geometry.type === "MultiPolygon"
				? geometry.coordinates.map((polygon) => polygon[0] ?? [])
				: []

	let sumLon = 0
	let sumLat = 0
	let count = 0

	for (const ring of exteriorRings) {
		for (const point of ring) {
			const [lon, lat] = point

			if (typeof lon !== "number" || typeof lat !== "number") continue

			sumLon += lon
			sumLat += lat

			count++
		}
	}

	if (count === 0) return undefined

	return { lat: sumLat / count, lon: sumLon / count }
}

/**
 * The production `blockCentroids` supplier: opens the TIGER blocks database READ-ONLY and probes `tabblock20.GEOID`
 * (uppercase) per lookup, decoding its GeoJSON `geometry` column via {@linkcode geometryCentroid}. Kept synchronous —
 * `BuildBDCOptions.blockCentroids` is a plain sync function (the same sync-by-interface discipline AGENTS.md documents
 * for the resolver ladder), so this uses `node:sqlite`'s raw `.prepare()`/`.get()` directly rather than Kysely. The
 * connection is left open for the caller's process lifetime (a read-path lookup, not a build) — same lifecycle as the
 * resolver-wof-sqlite lookups.
 */
export function createTIGERBlockCentroidLookup(
	tigerDBPath: string
): (geoid: string) => { lat: number; lon: number } | undefined {
	const db = openBuiltDatabase(tigerDBPath)
	const stmt = db.prepare("SELECT geometry FROM tabblock20 WHERE GEOID = ?")

	return (geoid: string) => {
		const row = stmt.get(geoid) as { geometry: string | null } | undefined

		return row ? geometryCentroid(row.geometry) : undefined
	}
}

/**
 * Rows per `INSERT` batch when populating `bdc_provider`. Far smaller than {@link STAGE_BATCH_SIZE}: that constant
 * tunes `bdc_availability`'s multi-million-row raw-prepared-statement path, whereas `bdc_provider` is a small
 * per-provider dictionary (thousands of rows, not millions) inserted through Kysely's typed `insertInto` — this batches
 * only to stay comfortably under SQLite's bound-parameter ceiling, not for throughput.
 */
const PROVIDER_INSERT_BATCH_SIZE = 500

/**
 * Groups `providers` by `providerID`. Task 3's `parseProviderList` yields one {@link ProviderListRow} PER LINE of the
 * source CSV, preserving cardinality (never folded, never last-wins — see that module's docstring) — so a `provider_id`
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
 * Populate `bdc_provider` from `options.providers` (2a decision 8 / 3a decision 6, Task 8) — see `schema.ts`'s
 * `BDCProviderTable` docstring for the full lossy-denormalization rationale. For each distinct `provider_id`:
 *
 * - Exactly one `frn` among its rows → that FRN is primary by construction; no `filerDB` query needed at all.
 * - More than one distinct `frn` → {@linkcode readFRNFilingCandidates} (`@mailwoman/filer/sdk`) reads each FRN's own most
 *   recent IN-FORCE `form-499` filing edge from `filerDB`, `asOf` the given date, and {@linkcode pickPrimaryFRN} picks
 *   the winner (decision 6: most recent 499 filing date wins). A `provider_id` whose FRNs carry NO 499 filing to rank
 *   by inserts `frn: NULL` rather than guessing — {@linkcode pickPrimaryFRN} throws on empty input, so this checks
 *   `candidates.length` first, mirroring `filerLookup`'s own `primary_frn: null` handling of the same case.
 * - `filerDB` is REQUIRED the instant a multi-FRN `provider_id` is encountered; its absence throws immediately, naming
 *   the offending `provider_id`, rather than silently picking an arbitrary FRN.
 *
 * `brand_name` and `holding_company` are always inserted NULL — see the schema docstring for why (no source at all for
 * the former; no decision-6 resolution rule for the latter's identical multi-value problem).
 */
async function populateBDCProviderTable(
	kdb: DatabaseClient<BDCDatabase>,
	providers: Iterable<ProviderListRow> | AsyncIterable<ProviderListRow>,
	filerDB: DatabaseClient<FilerDatabase> | undefined,
	asOf: string
): Promise<number> {
	const byProviderID = await groupProviderListRows(providers)
	const insertRows: Insertable<BDCProviderTable>[] = []

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

			const candidates = await readFRNFilingCandidates(filerDB, distinctFRNs, asOf)

			frn = candidates.length ? pickPrimaryFRN(candidates) : null
		}

		insertRows.push({ provider_id: providerID, frn, brand_name: null, holding_company: null })
	}

	for (let index = 0; index < insertRows.length; index += PROVIDER_INSERT_BATCH_SIZE) {
		await kdb
			.insertInto("bdc_provider")
			.values(insertRows.slice(index, index + PROVIDER_INSERT_BATCH_SIZE))
			.execute()
	}

	return insertRows.length
}

/**
 * Build `bdc.db`: stage (raw dedup) → materialize (resolve `h3_cell` per geoid, skip+count unknown geoids) → drop stage
 * → geoid index (index-after-load) → coverage → layer manifest → seal → atomic move-into-place. See the module
 * docstring for the two deliberate deviations from `build-poi.ts`.
 */
export async function buildBDCDatabase(options: BuildBDCOptions): Promise<BuildBDCResult> {
	const progress = options.onProgress ?? (() => {})

	if (!options.rows && (!options.csvPaths || !options.csvPaths.length)) {
		throw new Error(
			"buildBDCDatabase: pass either `rows` (test/injected source) or `csvPaths` (per-provider availability CSVs)"
		)
	}

	const buildingPath = `${options.out}.building`

	if (existsSync(buildingPath)) {
		rmSync(buildingPath)
	}

	mkdirSync(dirname(options.out), { recursive: true })

	const rowSource: AsyncIterable<BDCAvailabilityRow> | Iterable<BDCAvailabilityRow> =
		options.rows ?? readAvailabilityRowsFromCSVPaths(options.csvPaths!)

	const db = new DatabaseSync(buildingPath)
	// Build-tuning pragmas — identical to build-poi.ts's discipline.
	db.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")
	const kdb = new DatabaseClient<BDCDatabase>({ database: db })

	progress("creating manifest/coverage/availability/provider/stage tables")
	await createLayerManifestTable(asContractDB(kdb))
	await createLayerCoverageTable(asContractDB(kdb))
	await createBDCAvailabilityTable(kdb)
	await createBDCProviderTable(kdb)
	await createBDCStageTable(kdb)

	const insStage = db.prepare(
		`INSERT OR IGNORE INTO bdc_stage (
			geoid, provider_id, technology_code, location_id,
			max_advertised_download_speed, max_advertised_upload_speed, low_latency, business_residential_code
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	)

	let staged = 0
	let batch = 0

	progress("staging rows — raw prepared INSERT OR IGNORE on the natural key (the Redis-dedup replacement)")
	db.exec("BEGIN")

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

		batch++

		if (batch >= STAGE_BATCH_SIZE) {
			db.exec("COMMIT")
			db.exec("BEGIN")
			batch = 0
		}
	}

	db.exec("COMMIT")

	const stagedCountRow = db.prepare("SELECT COUNT(*) AS staged_count FROM bdc_stage").get() as {
		staged_count: number
	}

	const deduped = staged - stagedCountRow.staged_count

	progress(
		`staged ${stagedCountRow.staged_count.toLocaleString()} distinct row(s), ${deduped.toLocaleString()} deduped`
	)

	const centroidCache = new Map<string, { h3Cell: number; coverageCell: number } | null>()
	/**
	 * Res-6 short-cell int → observed row count, aggregated during materialize (one pass, no second scan) — matches
	 * `build-poi.ts`'s `coverage` Map.
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

	// The FCC's per-provider CSVs are per-BSL: the SAME (geoid, provider_id, technology_code, speeds, low_latency,
	// business_residential_code) tuple can repeat once per Broadband Serviceable Location within that block (a
	// dense urban block can carry ~100 BSLs) — `bdc_stage`'s natural key includes `location_id`, so those BSL rows
	// all survive the staging dedup as distinct staged rows. In `includeLocationIDs` mode that's correct: every BSL
	// is a real, distinct row the caller asked to keep. In the default (NULL `location_id`) mode, when those BSLs
	// ALSO share identical speeds/flags, they'd otherwise materialize as byte-identical rows, inflating `result.rows`
	// and `layer_coverage.observed_rows` by the BSL count (found in review, ~100x at real scale) — `SELECT DISTINCT`
	// over every column EXCEPT `location_id` collapses those byte-identical BSL duplicates down to one row.
	// IMPORTANT — this is NOT a guarantee of one row per (geoid, provider_id, technology_code) triple: BSLs at the
	// same triple with DIFFERING speeds/flags are NOT the same tuple, so `SELECT DISTINCT` does not merge them —
	// they survive as multiple NULL-`location_id` rows at that one triple. Accepted, not a bug; see the module
	// docstring and `filing-landscape.ts`'s docstring for the read-side consequence.
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

	db.exec("BEGIN")
	batch = 0

	for (const row of stageStmt.iterate() as IterableIterator<BDCStageRow>) {
		let resolved = centroidCache.get(row.geoid)

		if (resolved === undefined) {
			const centroid = options.blockCentroids(row.geoid)

			resolved = centroid
				? (() => {
						// Coverage cell MUST be derived as the res-9 cell's H3 hierarchy parent — NOT a second,
						// independent `latLngToCell(centroid, 6)` call. H3's cell hierarchy is not geometrically
						// exact: a point's directly-indexed res-6 cell and its res-9 cell's `cellToParent(…, 6)`
						// disagree for a real fraction of points (~6% empirically over CONUS, reviewer-verified —
						// hexagon/pentagon boundary artifacts). Deriving both `h3_cell` and the coverage cell from
						// the SAME full res-9 index is what lets `filing-landscape.ts`'s reader reconstruct this
						// exact coverage cell from nothing but the stored `h3_cell` (its `res9ShortCellToRes6Parent`
						// applies `cellToParent` to the reconstructed res-9 cell) — builder and reader must derive
						// the res-6 parent identically, or a genuinely-surveyed block can read back as unknown.
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
			// wof_id stays NULL here — WOF point-in-polygon resolution against the block centroid is a later
			// registry-join task, the same decision-8 scoping schema.ts documents for `bdc_provider`.
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

		batch++

		if (batch >= STAGE_BATCH_SIZE) {
			db.exec("COMMIT")
			db.exec("BEGIN")
			batch = 0
		}
	}

	db.exec("COMMIT")

	progress(
		`materialized ${inserted.toLocaleString()} row(s) across ${providers.size} provider(s) ` +
			`(${unknownGeoids.toLocaleString()} unknown geoid(s) skipped)`
	)

	await kdb.schema.dropTable("bdc_stage").execute()

	progress("geoid index (index-after-load — see schema.ts)")
	await createBDCGeoidIndex(kdb)

	// Coverage is SOURCE-LEVEL, not survey completeness — same convention build-poi.ts documents: a res-6 cell we
	// have availability rows in is recorded at completeness 1.0. A cell absent from `layer_coverage` means no rows
	// were observed there at all (the meaning-of-zero rule — missing = unknown, never `{completeness: 0}`).
	const coverageCells = [...coverage.entries()].map(([h3Cell, observedRows]) => ({
		h3Cell,
		completeness: 1,
		observedRows,
	}))

	await writeLayerCoverage(asContractDB(kdb), coverageCells)

	progress("writing layer manifest")

	await writeLayerManifest(asContractDB(kdb), {
		name: "bdc",
		version: options.asOfDate,
		schemaVersion: 1,
		tier: LayerTier.Shipped,
		license: "public-domain",
		attribution: BDC_ATTRIBUTION,
		source: "fcc-bdc",
		sourceVintage: options.asOfDate,
		buildCmd: "mailwoman gazetteer build bdc",
		buildSHA: options.buildSHA,
		freshnessPolicy: LayerFreshnessPolicy.VersionedRefresh,
		spineKeys: { h3: { column: "h3_cell", resolution: BDC_H3_RESOLUTION }, wofID: "wof_id" },
		createdAt: new Date().toISOString(),
	})

	// bdc_provider population (2a decision 8 / 3a decision 6, Task 8) — entirely additive and gated behind
	// `options.providers`: when absent, this block never runs and `bdc_provider` stays empty, exactly as before
	// Task 8 (see `BuildBDCOptions.providers`'s docstring — the default-path byte-identical guarantee).
	let providersPopulated = 0

	if (options.providers) {
		progress("populating bdc_provider from the provider list (decision 6 — lossy denormalization, see schema.ts)")

		providersPopulated = await populateBDCProviderTable(
			kdb,
			options.providers,
			options.filerDB,
			options.primaryFRNAsOf ?? options.asOfDate
		)

		progress(`bdc_provider: ${providersPopulated.toLocaleString()} provider(s) populated`)
	}

	progress("finalize: ANALYZE + VACUUM")
	db.exec("ANALYZE")
	// page_size MUST be set right before VACUUM — node:sqlite initializes the file at the 4096 default on
	// `new DatabaseSync`, so the earlier pragma is a no-op until a VACUUM rebuilds at the new size (build-poi.ts's
	// same discipline).
	db.exec("PRAGMA page_size=8192")
	db.exec("VACUUM")
	await kdb.destroy()

	progress("seal")
	sealDatabase(buildingPath)

	// Atomic move-into-place — the previous version is moved ASIDE FIRST, per the AGENTS.md database house rule
	// ("build successfully, then move the previous version to a temp directory, and then move the new version into
	// place"). Mirrors `mailwoman/eval-harness/gauntlet/build-regression-db.ts`'s `${output}.prev` swap. Deliberate
	// deviation from `build-poi.ts`'s direct-write — see the module docstring.
	if (existsSync(options.out)) {
		renameSync(options.out, `${options.out}.prev`)
	}

	renameSync(buildingPath, options.out)

	if (existsSync(`${options.out}.prev`)) {
		rmSync(`${options.out}.prev`)
	}

	return {
		out: options.out,
		rows: inserted,
		deduped,
		providers: providers.size,
		coverageCells: coverageCells.length,
		unknownGeoids,
		providersPopulated,
	}
}
