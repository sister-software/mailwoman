/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds and seals the `poi.db` layer from Overture Places or OSM rows.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePath } from "@mailwoman/core/fs/writers"
import {
	type CoverageCell,
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerTier,
	writeLayerCoverage,
	writeLayerManifest,
} from "@mailwoman/core/layers"
import { CoverageBasis } from "@mailwoman/evidence"
import {
	POI_H3_RESOLUTION,
	createPOIBrandIndex,
	createPOINameKeyIndex,
	createPOISearchFTS,
	createPOIStagingTables,
	createPOITable,
	POI_COLUMNS,
	POI_FTS_TABLE,
	type POIDatabase,
} from "@mailwoman/resolver-wof-sqlite/poi"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"
import { cellToParent, latLngToCell, polygonToCells } from "h3-js"
import { dirname, resolvePath, type PathBuilderLike } from "path-ts"

/**
 * Re-exports the Overture Places ingest so the POI build command can import ingest
 * and build from one module.
 */
export {
	chooseCategoryColumn,
	chooseCountryExpression,
	hasBrandColumn,
	ingestPlaces,
	type CountryExpression,
	type DescribeColumn,
	type IngestPlacesOptions,
	type IngestPlacesResult,
} from "#gazetteer-pipeline/poi/build/overture"

/**
 * Re-exports the pinned Overture release that the POI ingest uses by default.
 */
export { DEFAULT_RELEASE } from "#gazetteer-pipeline/poi/defaults"

const COVERAGE_H3_RESOLUTION = 6

const STAGE_BATCH_SIZE = 10_000

/**
 * One POI row in the flat shape that {@link buildPOIDatabase} loads.
 */
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

async function* streamPOIRows(parquetPaths: readonly string[]): AsyncIterable<POISourceRow> {
	const { DuckDBInstance } = await import("@duckdb/node-api")
	const instance = await DuckDBInstance.create()
	const db = await instance.connect()

	try {
		for (const parquetPath of parquetPaths) {
			const stream = await db.stream(
				`SELECT name, category, brand_wikidata, lat, lon, country, confidence, gers_id
				 FROM read_parquet('${parquetPath}')`
			)

			const colNames = stream.columnNames()

			for (let chunk = await stream.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await stream.fetchChunk()) {
				const rows = chunk.getRowObjects(colNames) as Array<{
					name: string | null
					category: string | null
					brand_wikidata: string | null
					lat: number
					lon: number
					country: string
					confidence: number
					gers_id: string | null
				}>

				for (const row of rows) {
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
		}
	} finally {
		db.closeSync()
	}
}

/**
 * A longitude and latitude rectangle, such as the declared bounding box of an OSM extract.
 */
export interface BBox {
	minLon: number
	minLat: number
	maxLon: number
	maxLat: number
}

/**
 * Returns every H3 cell covering a bounding box with its observed row count, including cells with no rows.
 *
 * Rows in cells outside the box are not counted, so the box should be the extract's full extent.
 */
export function bboxCoverageCells(
	bbox: BBox,
	rows: Iterable<Pick<POISourceRow, "latitude" | "longitude">>,
	resolution: number = COVERAGE_H3_RESOLUTION
): Array<{ h3Cell: number; observedRows: number }> {
	const observed = new Map<number, number>()

	for (const row of rows) {
		if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) continue

		const res9Cell = latLngToCell(row.latitude, row.longitude, POI_H3_RESOLUTION) as H3Cell
		const cell = cellToParent(res9Cell, resolution) as H3Cell
		const h3Cell = shortCellToInt(cell)

		observed.set(h3Cell, (observed.get(h3Cell) ?? 0) + 1)
	}

	const ring: number[][] = [
		[bbox.minLat, bbox.minLon],
		[bbox.minLat, bbox.maxLon],
		[bbox.maxLat, bbox.maxLon],
		[bbox.maxLat, bbox.minLon],
	]

	const polyfilled = polygonToCells(ring, resolution) as H3Cell[]

	return polyfilled.map((cell) => {
		const h3Cell = shortCellToInt(cell)

		return { h3Cell, observedRows: observed.get(h3Cell) ?? 0 }
	})
}

const SOURCE_MANIFEST_DEFAULTS = {
	"overture-places": {
		license: "CDLA-Permissive-2.0",
		attribution: "Overture Maps Foundation",
		tier: LayerTier.Shipped,
		shareAlike: false,
	},
	osm: { license: "ODbL-1.0", attribution: "OpenStreetMap contributors", tier: LayerTier.BuildLocal, shareAlike: true },
} as const satisfies Record<string, { license: string; attribution: string; tier: LayerTier; shareAlike: boolean }>

/**
 * Options for {@link buildPOIDatabase}.
 */
export interface BuildPOIOptions {
	/**
	 * The per-country Parquet files from `ingestPlaces`.
	 * Required unless `rows` is given.
	 */
	parquetPaths?: readonly string[]

	/**
	 * A row source that replaces the Parquet read.
	 */
	rows?: AsyncIterable<POISourceRow> | Iterable<POISourceRow>

	/**
	 * The output `poi.db` path.
	 * An existing file is deleted and rebuilt.
	 */
	out: PathBuilderLike

	/**
	 * The source release, recorded as the manifest's `sourceVintage`.
	 */
	release: string

	/**
	 * The short git SHA of the build.
	 */
	buildSHA: string

	/**
	 * The manifest's `version`.
	 * Defaults to `release`.
	 */
	version?: string

	/**
	 * The ISO-8601 manifest timestamp.
	 *
	 * Defaults to the current time.
	 * Pass it for reproducible builds.
	 */
	createdAt?: string

	/**
	 * The manifest source, which also selects the licence and attribution.
	 * Defaults to `"overture-places"`.
	 */
	source?: "overture-places" | "osm"

	/**
	 * The manifest distribution tier.
	 *
	 * Defaults to {@link LayerTier.BuildLocal} for OSM and {@link LayerTier.Shipped} otherwise.
	 *
	 * An OSM build cannot be {@link LayerTier.Shipped} because ODbL is share-alike.
	 */
	tier?: LayerTier

	/**
	 * Coverage cells that replace the cells observed in the rows, for example from {@link bboxCoverageCells}.
	 *
	 * Each cell keeps its `observedRows`, including 0.
	 * `completeness` defaults to 1 and `basis` defaults to {@link CoverageBasis.SourcePresent}.
	 *
	 * A stronger basis such as {@link CoverageBasis.Surveyed} must be set here explicitly.
	 */
	coverageCellsOverride?: Iterable<{
		h3Cell: number
		observedRows: number
		completeness?: number
		basis?: CoverageBasis
	}>
	onProgress?: (phase: string, message: string) => void
}

/**
 * The output path and counts from a POI build.
 */
export interface BuildPOIResult {
	out: string

	/**
	 * The number of rows written to the `poi` table.
	 */
	rows: number

	/**
	 * The number of rows dropped for a non-finite latitude or longitude.
	 */
	skipped: number

	/**
	 * The number of distinct categories, excluding the reserved uncategorized code 0.
	 */
	categories: number

	/**
	 * The number of kept rows per ISO country code.
	 */
	countries: Map<string, number>

	/**
	 * The number of coverage cells written.
	 */
	coverageCells: number
}

/**
 * Builds and seals `poi.db` from POI rows, replacing any existing file at `out`.
 *
 * The build stages and dictionary-encodes the rows, writes the table in H3 cell order,
 * and adds the indexes, FTS table, layer manifest, and coverage.
 */
export async function buildPOIDatabase(opts: BuildPOIOptions): Promise<BuildPOIResult> {
	const progress = opts.onProgress ?? (() => {})

	if (!opts.rows && (!opts.parquetPaths || !opts.parquetPaths.length)) {
		throw new Error("buildPOIDatabase: pass either `rows` (test/injected source) or `parquetPaths` (from ingestPlaces)")
	}

	const source = opts.source ?? "overture-places"
	const sourceManifestDefaults = SOURCE_MANIFEST_DEFAULTS[source]
	const tier = opts.tier ?? sourceManifestDefaults.tier

	if (sourceManifestDefaults.shareAlike && tier === LayerTier.Shipped) {
		throw new Error(
			`buildPOIDatabase: ${source} is ${sourceManifestDefaults.license}, so the layer cannot be tier "shipped"`
		)
	}

	if (await pathExists(opts.out)) {
		await removePath(opts.out)
	}

	await makeDirectories(dirname(opts.out))

	const rowSource: AsyncIterable<POISourceRow> | Iterable<POISourceRow> = opts.rows ?? streamPOIRows(opts.parquetPaths!)

	const categoryCodes = new Map<string, number>()
	const countries = new Map<string, number>()
	let inserted = 0
	let skipped = 0

	let coverageCells: CoverageCell[]

	{
		using kdb = new DatabaseClient<POIDatabase>(opts.out)

		kdb.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")

		progress("stage", "creating staging + dictionary tables")
		await createPOIStagingTables(kdb)
		await createLayerManifestTable(kdb)
		await createLayerCoverageTable(kdb)

		const categoryID = (category: string | null): number => {
			if (!category) return 0
			let id = categoryCodes.get(category)

			if (id === undefined) {
				id = categoryCodes.size + 1
				categoryCodes.set(category, id)
			}

			return id
		}

		const coverage = new Map<number, number>()

		const insStage = kdb.prepare(`INSERT INTO poi_stage VALUES (${POI_COLUMNS.map(() => "?").join(", ")})`)

		let rowidKey = 0
		let batch = 0

		progress("load", "streaming rows into poi_stage")
		kdb.exec("BEGIN")

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
				kdb.exec("COMMIT")
				kdb.exec("BEGIN")
				batch = 0
			}
		}

		kdb.exec("COMMIT")
		progress("load", `${inserted.toLocaleString()} staged, ${skipped.toLocaleString()} skipped (non-finite coords)`)

		if (categoryCodes.size) {
			await kdb
				.insertInto("poi_category_codes")
				.values([...categoryCodes].map(([category, id]) => ({ id, category })))
				.execute()
		}

		progress("materialize", "building clustered poi table")
		await createPOITable(kdb)
		const cols = POI_COLUMNS.join(", ")

		kdb.exec(
			`INSERT INTO poi (${cols}) SELECT ${cols} FROM poi_stage ORDER BY h3_cell, category_id, neg_rank, rowid_key;`
		)

		await kdb.schema.dropTable("poi_stage").execute()

		progress("index", "name_key + brand_wikidata indexes (index-after-load)")
		await createPOINameKeyIndex(kdb)
		await createPOIBrandIndex(kdb)

		progress("fts", "building FTS5 name index")
		createPOISearchFTS(kdb)

		kdb.exec(
			`INSERT INTO ${POI_FTS_TABLE} (name, name_key, h3_cell) SELECT name, name_key, h3_cell FROM poi WHERE name IS NOT NULL;`
		)

		progress("manifest", "writing layer manifest + coverage")

		await writeLayerManifest(kdb, {
			name: "poi",
			version: opts.version ?? opts.release,
			schemaVersion: 1,
			tier,
			license: sourceManifestDefaults.license,
			attribution: sourceManifestDefaults.attribution,
			source,
			sourceVintage: opts.release,
			buildCmd: "mailwoman gazetteer build poi",
			buildSHA: opts.buildSHA,
			freshnessPolicy: "sealed",
			spineKeys: { h3: { column: "h3_cell", resolution: POI_H3_RESOLUTION } },
			createdAt: opts.createdAt ?? new Date().toISOString(),
		})

		coverageCells = opts.coverageCellsOverride
			? [...opts.coverageCellsOverride].map((c) => ({
					h3Cell: c.h3Cell,
					completeness: c.completeness ?? 1,
					basis: c.basis ?? CoverageBasis.SourcePresent,
					observedRows: c.observedRows,
				}))
			: [...coverage.entries()].map(([h3Cell, observedRows]) => ({
					h3Cell,
					completeness: 1,
					basis: CoverageBasis.SourcePresent,
					observedRows,
				}))

		await writeLayerCoverage(kdb, coverageCells)

		progress("finalize", "ANALYZE + VACUUM")
		kdb.exec("ANALYZE")

		kdb.exec("PRAGMA page_size=8192")
		kdb.exec("VACUUM")
	}

	const out = resolvePath(opts.out)
	progress("seal", out)
	await sealDatabase(out)

	return {
		out,
		rows: inserted,
		skipped,
		categories: categoryCodes.size,
		countries,
		coverageCells: coverageCells.length,
	}
}
