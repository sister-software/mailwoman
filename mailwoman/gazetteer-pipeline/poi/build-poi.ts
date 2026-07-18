/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `poi.db` builder (spec §3.4, Task 3 of the POI Data + MCP plan) — the Overture Places ingest
 *   + the clustered res-9 `poi` table Task 1's schema (`poi-schema.ts`) defines, queried by Task 2's
 *   {@link POILookup}.
 *
 *   Two phases, split so the load/materialize/seal phase is testable WITHOUT DuckDB or network:
 *
 *   1. {@linkcode ingestPlaces} — DuckDB (lazy-imported, the `overture-ingest.tsx` convention) over
 *        the Overture places theme on S3, per-country predicate pushdown into local Parquet. The
 *        Places schema's category/brand columns are STRUCTs whose shape has churned across releases
 *        (the `taxonomy` property is newer than `categories`); {@linkcode chooseCategoryColumn} +
 *        {@linkcode hasBrandColumn} are PURE functions over a `DESCRIBE` result, so the column-choice
 *        logic is unit-testable without touching the network (see `overture-places-schema.test.ts`).
 *   2. {@linkcode buildPOIDatabase} — stream rows (from the ingested Parquet by default, or an
 *        injected `Iterable`/`AsyncIterable<POISourceRow>` for tests) into a `poi_stage` staging
 *        table, dictionary-encode categories (insert-on-first-sight, 0 = uncategorized), pack each
 *        row's res-9 H3 cell via `@mailwoman/spatial`'s `shortenH3Cell` (never reimplemented — see
 *        AGENTS.md), materialize the clustered `WITHOUT ROWID` `poi` table pre-sorted by
 *        `(h3_cell, category_id, neg_rank, rowid_key)`, build the name-key index + FTS5 name search,
 *        write the layer-contract manifest + per-res-6-cell coverage, then seal.
 *
 *   Build-on-copy: `build-candidate.ts` (the closer anchor for "dictionaries + clustered
 *   materialize", also named in the task brief) writes DIRECTLY to its output path (removing any
 *   stale file first) and lets the caller `sealDatabase` once the connection closes — no
 *   `<out>.building`-suffix temp-swap. This builder mirrors THAT precedent rather than the
 *   `admin/index.ts` staging-suffix + `VACUUM INTO` dance (which exists there for a much longer,
 *   multi-source, resumable build where a mid-build crash mustn't corrupt a promoted artifact); a
 *   single-pass POI build has no such intermediate-promotion concern, and `sealDatabase` itself
 *   already refuses to run against a live writer. Deviation from the task brief's literal
 *   `<out>.building` instruction, per the brief's own "follow the anchor, record the deviation" rule.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import {
	createLayerCoverageTable,
	createLayerManifestTable,
	writeLayerCoverage,
	writeLayerManifest,
	type LayerContractDatabase,
} from "@mailwoman/core/layers"
import { dataRootPath, sealDatabase } from "@mailwoman/core/utils"
import { POI_H3_RESOLUTION } from "@mailwoman/resolver-wof-sqlite/poi-lookup"
import {
	createPOINameKeyIndex,
	createPOISearchFTS,
	createPOIStagingTables,
	createPOITable,
	POI_COLUMNS,
	POI_FTS_TABLE,
	type POIDatabase,
} from "@mailwoman/resolver-wof-sqlite/poi-schema"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { shortenH3Cell, type H3Cell } from "@mailwoman/spatial"
import { cellToParent, latLngToCell } from "h3-js"

/**
 * Pinned Overture release for the places-theme ingest. Matches `overture-ingest.tsx`'s own `DEFAULT_RELEASE` pin (the
 * addresses-theme ingest) as of this writing — a monthly Overture release covers every theme at once, so the two pins
 * move together in practice. Kept as an INDEPENDENT constant here rather than imported from that `.tsx` command:
 * `gazetteer-pipeline/*.ts` must stay importable under plain `node` type-stripping (no JSX transform), and
 * `commands/**\/*.tsx` files are Ink/Pastel presentation that require compiling (AGENTS.md) — pulling a value FROM a
 * `.tsx` file into this pipeline layer would invert that dependency direction. If the pins drift, `--release` overrides
 * either independently.
 */
export const DEFAULT_RELEASE = "2026-05-20.0"

/** Coverage is aggregated one level coarser than the row spine — a res-6 cell covers a whole metro area. */
const COVERAGE_H3_RESOLUTION = 6
/** Confidence floor already applied by `ingestPlaces`'s Parquet predicate — restated here as the loader's own gate. */
const MIN_CONFIDENCE = 0.85
/** Rows committed per `BEGIN`/`COMMIT` batch during the staging load (the candidate-builder discipline). */
const STAGE_BATCH_SIZE = 10_000

const S3_GLOB = (release: string) => `s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*.parquet`

/**
 * A row of `DESCRIBE SELECT * FROM read_parquet(...)` — just the column name matters for the schema probe.
 */
export interface DescribeColumn {
	column_name: string
}

/**
 * PURE column-choice logic over a `DESCRIBE` result — no DuckDB/network in this function, so it's unit-testable on its
 * own. Overture's places-theme category struct has gone by `taxonomy` (newer) and `categories` (older); prefer
 * `taxonomy.primary` when the column is present.
 */
export function chooseCategoryColumn(
	describeRows: readonly DescribeColumn[]
): "taxonomy.primary" | "categories.primary" {
	return describeRows.some((r) => r.column_name === "taxonomy") ? "taxonomy.primary" : "categories.primary"
}

/** PURE: whether the `brand` STRUCT column is present in this release's places schema. */
export function hasBrandColumn(describeRows: readonly DescribeColumn[]): boolean {
	return describeRows.some((r) => r.column_name === "brand")
}

export interface IngestPlacesOptions {
	/** Pinned Overture release. Default {@link DEFAULT_RELEASE} (the same pin `overture-ingest.tsx` uses). */
	release?: string
	/** ISO 3166-1 alpha-2 codes to materialize. */
	countries: readonly string[]
	/** Output root for the per-country Parquet. Default `<data-root>/overture/<release>/places`. */
	out?: string
	/** Cap rows per country (debug). */
	limit?: number
	onPhase?: (phase: string, detail?: string) => void
}

export interface IngestPlacesResult {
	release: string
	outDir: string
	/** ISO country code → the local Parquet path materialized for it. */
	countryParquet: Record<string, string>
	categoryColumn: "taxonomy.primary" | "categories.primary"
	hasBrand: boolean
}

/**
 * Overture places-theme ingest: predicate-pushdown per-country COPY into local Parquet, mirroring `overture-ingest.tsx`
 * (lazy DuckDB, `s3_region='us-west-2'`, `threads=4`, `memory_limit='8GB'`). Probes the release's places schema once
 * (`DESCRIBE`) via the PURE {@link chooseCategoryColumn}/{@link hasBrandColumn} before issuing the per-country COPYs.
 */
export async function ingestPlaces(opts: IngestPlacesOptions): Promise<IngestPlacesResult> {
	const release = opts.release ?? DEFAULT_RELEASE
	const outDir = opts.out ?? dataRootPath("overture", release, "places")
	mkdirSync(outDir, { recursive: true })
	const phase = opts.onPhase ?? (() => {})

	// @duckdb/node-api is an optional peer dep — lazy import so merely loading this module (e.g. via
	// the `poi.tsx` command import graph under `mailwoman --help`) doesn't fault when it's absent.
	const { DuckDBInstance } = await import("@duckdb/node-api")
	const instance = await DuckDBInstance.create()
	const db = await instance.connect()

	await db.run("INSTALL httpfs; LOAD httpfs;")
	await db.run("INSTALL spatial; LOAD spatial;")
	await db.run("SET s3_region='us-west-2';")
	await db.run("SET threads=4;")
	await db.run("SET memory_limit='8GB';")

	const glob = S3_GLOB(release)

	phase("probe", "DESCRIBE places schema")
	const describeResult = await db.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${glob}') LIMIT 1`)
	const describeRows = describeResult.getRowObjects() as unknown as DescribeColumn[]
	const categoryColumn = chooseCategoryColumn(describeRows)
	const hasBrand = hasBrandColumn(describeRows)
	phase("probe", `category column: ${categoryColumn}; brand: ${hasBrand ? "present" : "absent"}`)

	// brand.wikidata only: the QID is the join key; the row's own name carries the display form.
	// brand.names.primary is deliberately NOT extracted (review 2026-07-18).
	const brandExprs = hasBrand ? "brand.wikidata AS brand_wikidata" : "CAST(NULL AS VARCHAR) AS brand_wikidata"

	const countryParquet: Record<string, string> = {}

	for (const cc of opts.countries) {
		const dest = join(outDir, `places-${cc.toLowerCase()}.parquet`)
		const limitClause = opts.limit ? `LIMIT ${opts.limit}` : ""
		const started = Date.now()
		await db.run(`
			COPY (
				SELECT
					id AS gers_id,
					names.primary AS name,
					${categoryColumn} AS category,
					${brandExprs},
					confidence,
					ST_X(geometry) AS lon,
					ST_Y(geometry) AS lat,
					country
				FROM read_parquet('${glob}', hive_partitioning = 1)
				WHERE country = '${cc}' AND confidence >= ${MIN_CONFIDENCE}
				${limitClause}
			) TO '${dest}' (FORMAT PARQUET, COMPRESSION SNAPPY)
		`)
		const secs = ((Date.now() - started) / 1000).toFixed(0)
		phase("ingest", `${cc} -> ${dest} (${secs}s)`)
		countryParquet[cc] = dest
	}

	db.closeSync()

	return { release, outDir, countryParquet, categoryColumn, hasBrand }
}

/** One Overture Places row, decoded to the flat shape the loader consumes — the injected-iterator testability seam. */
export interface POISourceRow {
	name: string | null
	category: string | null
	brandWikidata: string | null
	latitude: number
	longitude: number
	country: string
	confidence: number
	gersID: string | null
}

/** Reads a country Parquet materialized by {@link ingestPlaces} back into {@link POISourceRow}s via DuckDB. */
async function* readParquetRows(parquetPaths: readonly string[]): AsyncIterable<POISourceRow> {
	// Lazy DuckDB import — this generator is only invoked when the caller didn't inject `rows`
	// (buildPOIDatabase's test path never reaches here), preserving the "DuckDB touches only the
	// ingest/read functions" rule.
	const { DuckDBInstance } = await import("@duckdb/node-api")
	const instance = await DuckDBInstance.create()
	const db = await instance.connect()

	try {
		for (const parquetPath of parquetPaths) {
			const result = await db.runAndReadAll(
				`SELECT name, category, brand_wikidata, lat, lon, country, confidence, gers_id
				 FROM read_parquet('${parquetPath}')`
			)

			for (const row of result.getRowObjects() as unknown as Array<{
				name: string | null
				category: string | null
				brand_wikidata: string | null
				lat: number
				lon: number
				country: string
				confidence: number
				gers_id: string | null
			}>) {
				yield {
					name: row.name,
					category: row.category,
					brandWikidata: row.brand_wikidata,
					latitude: Number(row.lat),
					longitude: Number(row.lon),
					country: row.country,
					confidence: Number(row.confidence),
					gersID: row.gers_id,
				}
			}
		}
	} finally {
		db.closeSync()
	}
}

export interface BuildPOIOptions {
	/**
	 * Per-country Parquet paths from {@link ingestPlaces} — read via DuckDB. Ignored when `rows` is given. Required unless
	 * `rows` is given.
	 */
	parquetPaths?: readonly string[]
	/**
	 * Injected row source — the testability seam. When given, the DuckDB read is skipped entirely (tests never touch
	 * DuckDB).
	 */
	rows?: AsyncIterable<POISourceRow> | Iterable<POISourceRow>
	/** Output `poi.db` path. Removed + rebuilt if already present (build-on-copy at the file level; see module docstring). */
	out: string
	/** Overture release this build's rows came from — becomes the manifest's `sourceVintage`. */
	release: string
	/** `git rev-parse --short HEAD` — passed in by the command, not read from the repo here. */
	buildSHA: string
	/** Layer manifest's own `version` field. Defaults to `release` — the layer has no independent versioning yet. */
	version?: string
	/** ISO-8601 manifest timestamp. Defaults to `new Date().toISOString()` — callers wanting reproducible builds pass it. */
	createdAt?: string
	onProgress?: (phase: string, message: string) => void
}

export interface BuildPOIResult {
	out: string
	/** Rows materialized into the final `poi` table. */
	rows: number
	/** Rows dropped for non-finite lat/lon — never inserted. */
	skipped: number
	/** Distinct categories dictionary-encoded (excludes the reserved `0` uncategorized code). */
	categories: number
	/** ISO country code → rows kept for it (skipped rows are NOT counted). */
	countries: Map<string, number>
	/** Res-6 coverage cells written. */
	coverageCells: number
}

/**
 * `poi.h3_cell` / `layer_coverage.h3_cell` are the SHORTENED (48-bit) cell as an integer — never the full h3-js cell
 * string.
 */
function shortCellToInt(cell: H3Cell): number {
	return Number(BigInt(`0x${shortenH3Cell(cell)}`))
}

/**
 * `POIDatabase extends LayerContractDatabase` structurally (it has every layer-contract table plus its own), but
 * Kysely's `transaction()` method makes `Kysely<DB>` INVARIANT in `DB` — a `Kysely<POIDatabase>` handle is not directly
 * assignable to `Kysely<LayerContractDatabase>`, even though every query the contract helpers issue
 * (`layer_manifest`/`layer_coverage` only) is perfectly valid against a POI-backed connection. This narrows the view
 * back down for the four `@mailwoman/core/layers` calls below rather than widening the shared package's function
 * signatures to a generic `DB extends LayerContractDatabase` (tried first — that breaks the FUNCTIONS' OWN internal
 * `insertInto`/`selectFrom` calls, since Kysely can't resolve `DB["layer_manifest"]`'s concrete columns through an
 * unresolved generic bound).
 */
function asContractDB(kdb: DatabaseClient<POIDatabase>): DatabaseClient<LayerContractDatabase> {
	return kdb as unknown as DatabaseClient<LayerContractDatabase>
}

/**
 * Build `poi.db`: stage → dictionary-encode → materialize the clustered table → FTS → layer manifest/coverage →
 * ANALYZE/VACUUM → seal. See the module docstring for the two-phase split and the build-on-copy deviation from the task
 * brief.
 */
export async function buildPOIDatabase(opts: BuildPOIOptions): Promise<BuildPOIResult> {
	const progress = opts.onProgress ?? (() => {})

	if (!opts.rows && (!opts.parquetPaths || opts.parquetPaths.length === 0)) {
		throw new Error("buildPOIDatabase: pass either `rows` (test/injected source) or `parquetPaths` (from ingestPlaces)")
	}

	if (existsSync(opts.out)) {
		rmSync(opts.out)
	}

	mkdirSync(dirname(opts.out), { recursive: true })

	const rowSource: AsyncIterable<POISourceRow> | Iterable<POISourceRow> =
		opts.rows ?? readParquetRows(opts.parquetPaths!)

	const db = new DatabaseSync(opts.out)
	// Build-tuning pragmas (raw — Kysely doesn't model PRAGMA), matching build-candidate.ts's discipline.
	db.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")
	const kdb = new DatabaseClient<POIDatabase>({ database: db })

	progress("stage", "creating staging + dictionary tables")
	await createPOIStagingTables(kdb)
	await createLayerManifestTable(asContractDB(kdb))
	await createLayerCoverageTable(asContractDB(kdb))

	const categoryCodes = new Map<string, number>()
	const categoryID = (category: string | null): number => {
		if (!category) return 0
		let id = categoryCodes.get(category)

		if (id === undefined) {
			// 0 is reserved for "uncategorized" — first real category gets 1.
			id = categoryCodes.size + 1
			categoryCodes.set(category, id)
		}

		return id
	}

	/** ISO country code → rows kept for it (skipped rows are NOT counted). */
	const countries = new Map<string, number>()
	/** Res-6 short-cell int → observed row count, aggregated during the load (one pass, no second scan). */
	const coverage = new Map<number, number>()

	const insStage = db.prepare(`INSERT INTO poi_stage VALUES (${POI_COLUMNS.map(() => "?").join(", ")})`)

	let rowidKey = 0
	let inserted = 0
	let skipped = 0
	let batch = 0

	progress("load", "streaming rows into poi_stage")
	db.exec("BEGIN")

	for await (const row of rowSource) {
		if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) {
			skipped++
			continue
		}

		const fullCell = latLngToCell(row.latitude, row.longitude, POI_H3_RESOLUTION) as H3Cell
		const h3Cell = shortCellToInt(fullCell)
		const catID = categoryID(row.category)
		const negRank = -Math.log10(row.confidence + 1e-6)
		const nameKey = row.name ? normalizeLocalityForKey(row.name) : null
		rowidKey++

		insStage.run(
			h3Cell,
			catID,
			negRank,
			rowidKey,
			row.name,
			nameKey,
			row.brandWikidata,
			row.latitude,
			row.longitude,
			row.country,
			row.confidence,
			row.gersID
		)
		inserted++
		countries.set(row.country, (countries.get(row.country) ?? 0) + 1)

		const parentCell = cellToParent(fullCell, COVERAGE_H3_RESOLUTION) as H3Cell
		const coverageCell = shortCellToInt(parentCell)
		coverage.set(coverageCell, (coverage.get(coverageCell) ?? 0) + 1)

		batch++

		if (batch >= STAGE_BATCH_SIZE) {
			db.exec("COMMIT")
			db.exec("BEGIN")
			batch = 0
		}
	}
	db.exec("COMMIT")
	progress("load", `${inserted.toLocaleString()} staged, ${skipped.toLocaleString()} skipped (non-finite coords)`)

	if (categoryCodes.size > 0) {
		await kdb
			.insertInto("poi_category_codes")
			.values([...categoryCodes].map(([category, id]) => ({ id, category })))
			.execute()
	}

	progress("materialize", "building clustered poi table")
	await createPOITable(kdb)
	const cols = POI_COLUMNS.join(", ")
	db.exec(`INSERT INTO poi (${cols}) SELECT ${cols} FROM poi_stage ORDER BY h3_cell, category_id, neg_rank, rowid_key;`)
	await kdb.schema.dropTable("poi_stage").execute()

	progress("index", "name_key index (index-after-load)")
	await createPOINameKeyIndex(kdb)

	progress("fts", "building FTS5 name index")
	createPOISearchFTS(db)
	db.exec(
		`INSERT INTO ${POI_FTS_TABLE} (name, name_key, h3_cell) SELECT name, name_key, h3_cell FROM poi WHERE name IS NOT NULL;`
	)

	progress("manifest", "writing layer manifest + coverage")
	await writeLayerManifest(asContractDB(kdb), {
		name: "poi",
		version: opts.version ?? opts.release,
		schemaVersion: 1,
		tier: "shipped",
		license: "CDLA-Permissive-2.0",
		attribution: "Overture Maps Foundation",
		source: "overture-places",
		sourceVintage: opts.release,
		buildCmd: "mailwoman gazetteer build poi",
		buildSHA: opts.buildSHA,
		freshnessPolicy: "sealed",
		spineKeys: { h3: { column: "h3_cell", resolution: POI_H3_RESOLUTION } },
		createdAt: opts.createdAt ?? new Date().toISOString(),
	})

	// Coverage is SOURCE-LEVEL, not survey completeness: a res-6 cell we have Overture Places rows in
	// is recorded at completeness 1.0 (Overture claims global coverage for the theme); this is NOT a
	// claim about how complete Overture's own Places extraction is within that cell. A cell absent
	// from `layer_coverage` means no rows were observed there at all — the meaning-of-zero rule
	// (missing = unknown, never `{completeness: 0}`).
	const coverageCells = [...coverage.entries()].map(([h3Cell, observedRows]) => ({
		h3Cell,
		completeness: 1,
		observedRows,
	}))
	await writeLayerCoverage(asContractDB(kdb), coverageCells)

	progress("finalize", "ANALYZE + VACUUM")
	db.exec("ANALYZE")
	// page_size MUST be set right before VACUUM (node:sqlite initializes the file at the 4096 default
	// on `new DatabaseSync`, so the earlier pragma is a no-op until a VACUUM rebuilds at the new size)
	// — the same discipline build-candidate.ts uses.
	db.exec("PRAGMA page_size=8192")
	db.exec("VACUUM")
	await kdb.destroy()

	progress("seal", opts.out)
	sealDatabase(opts.out)

	return {
		out: opts.out,
		rows: inserted,
		skipped,
		categories: categoryCodes.size,
		countries,
		coverageCells: coverageCells.length,
	}
}
