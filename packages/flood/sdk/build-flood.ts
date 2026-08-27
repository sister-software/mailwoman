/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `flood.db` — the sealed two-tier polygon layer, from the authority's published geodatabase.
 *
 *   THE ACCUMULATION IS IN SQL, NOT IN A MAP. Classification is per feature and shared with the resolution
 *   measurement (`classifyFeatureCells`), but where the touches GO differs on purpose: the measuring
 *   instrument holds them in memory because it is comparing candidate resolutions in one pass, and the
 *   builder streams them into a temporary table because memory has to stay flat in row count. The poi
 *   build ran out of heap at 13.68M rows for exactly the shape this avoids, and a polygon layer's touches
 *   outnumber its features.
 *
 *   ZONE 1 IS WRITTEN AS COVERAGE, NOT AS ROWS. Inside England a location with no polygon is not
 *   unsurveyed — the Planning Practice Guidance defines Zone 1 as the land outside Zones 2 and 3 — so the
 *   designated absence is carried by a `layer_coverage` row at `basis = designated`, `completeness = 1.0`.
 *   Outside England there is NO ROW, because the EA's statement says nothing about Wales, Scotland or
 *   Northern Ireland, each of which has a different authority and a different zone scheme. Those two
 *   readings must never collapse into one another, and the negative half of the verification exists to
 *   prove they do not.
 *
 *   A COVERAGE ROW LICENSES ONLY THAT THE AUTHORITY DETERMINED HERE. The hazard reading is the zone value.
 *   A `designated`-complete cell holding no polygon says the EA's map assigns Zone 1 there; it does not
 *   say the location will not flood, and the authority itself declines that second statement.
 *
 *   THE COVERAGE CELL OF A ROW IS `cellToParent` OF ITS FINER CELL, never a fresh `latLngToCell` at the
 *   coarse resolution — that is what every existing reader in this repo does, and the two agree for a
 *   point but not for a cell.
 *
 *   THE AREA CROSS-CHECK IS BELT AND BRACES AND IT STAYS. The EA's rings nest their holes properly, so the
 *   orientation-encoded hole trap the zoning survey measured does not fire here. The check costs one
 *   subtraction per feature and its absence is silent: a hole read as an exterior ring produces a
 *   well-formed polygon that simply covers ground the authority did not map, and answers "inside" for
 *   every point in it.
 */

import { statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import {
	CoverageBasis,
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerFreshnessPolicy,
	LayerTier,
	writeLayerCoverage,
	writeLayerManifest,
	type CoverageCell,
} from "@mailwoman/core/layers"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/core/utils"
import { expandH3Cell, shortCellToInt, type H3Cell, type H3CellShort } from "@mailwoman/spatial"
import { cellToChildren, cellToParent, compactCells, getResolution } from "h3-js"

import { encodeRings, ringAreaReadings } from "../rings.ts"
import { createFloodTables, FloodCellContainment, type FloodDatabase } from "../schema.ts"
import {
	EA_FLOOD_ATTRIBUTION,
	EA_FLOOD_DATASET_ID,
	EA_FLOOD_LAYER_NAME,
	EA_FLOOD_LICENSE,
	EA_FLOOD_ZONE_CODES,
	EA_FLOOD_ZONE_DEFINITIONS,
} from "../vocabulary.ts"
import { classifyFeatureCells } from "./cells.ts"
import type { FloodMapExtent } from "./extent.ts"
import type { FloodFeatureSource } from "./ingest.ts"

/**
 * Schema version of the domain tables. Bumped when a column changes meaning, never for an added column a reader can
 * ignore.
 */
export const FLOOD_SCHEMA_VERSION = 1

/**
 * Rows per bulk-insert transaction. Chosen for the geometry table, whose rows carry a blob: a larger transaction grows
 * the WAL without improving throughput.
 */
const INSERT_TRANSACTION_ROWS = 5000

/**
 * The relative gap between the two area readings that fails the build.
 *
 * The comparison is a spherical ring area against GDAL's planar area in the source's own projection, so the two never
 * agree exactly: British National Grid's scale factor runs 0.9996 at its central meridian to about 1.0004 at the edges
 * of its usable zone, contributing roughly a tenth of a percent, and the spherical approximation contributes a similar
 * amount against the ellipsoid. One percent leaves both of those far inside the tolerance while sitting well below the
 * error a hole-blind read produces — the zoning survey measured that at 4.1% over a whole national layer.
 */
const AREA_TOLERANCE = 0.01

export interface BuildFloodOptions {
	/**
	 * Where the features come from — the published geodatabase in a real build, a hand-built list in a fixture.
	 */
	source: FloodFeatureSource
	/**
	 * Where the sealed artifact lands. The build writes beside it and swaps.
	 */
	out: string
	/**
	 * The product's ISO revision date — `layer_manifest.version` and `source_vintage`.
	 */
	sourceVintage: string
	buildCmd: string
	buildSHA: string
	/**
	 * ISO-8601, supplied by the caller. Never generated here: the contract says so, and a library-generated timestamp
	 * makes two builds of the same inputs differ.
	 */
	createdAt: string
	/**
	 * The resolution the cell index is built at — chosen from the `partial`-share measurement.
	 */
	indexResolution: number
	/**
	 * The resolution `layer_coverage` rows are keyed at. Must be coarser than the index resolution.
	 */
	coverageResolution: number
	/**
	 * The authority's footprint, already realized against a boundary artifact.
	 */
	extent: FloodMapExtent
	/**
	 * The feature count a SECOND distribution channel reports — the live WFS. Supplied, it is asserted against the
	 * geodatabase's own count, which is the cheapest two-path check available and catches a stale or truncated archive
	 * before anything is written.
	 */
	expectedFeatureCount?: number
	onProgress?: (message: string) => void
}

export interface BuildFloodResult {
	out: string
	features: number
	zoneCounts: Record<string, number>
	indexResolution: number
	coverageResolution: number
	wholeCellRows: number
	partialCellRows: number
	candidateRows: number
	/**
	 * `partialCellRows / (wholeCellRows + partialCellRows)` at the built resolution, over the STORED rows — the whole
	 * side is compacted, so this is not the same number the resolution was chosen on and is reported separately.
	 */
	storedPartialShare: number
	/**
	 * Features whose bounding box forced a resolution coarser than `indexResolution`, and the resolutions the stored cell
	 * rows are actually at. Both are reported rather than smoothed over: a reader that assumed one resolution would probe
	 * at the wrong one and read every coarsened feature as an absence.
	 */
	coarsenedFeatures: number
	storedResolutions: number[]
	coverageCells: number
	coverageCellsWithRows: number
	/**
	 * The three area totals, in square kilometres: what the source says, what the encoded rings say read with their
	 * holes, and what they would say read without.
	 */
	area: { sourceKM2: number; nestedKM2: number; allExteriorKM2: number; relativeGap: number }
	sizeBytes: number
}

/**
 * Build the layer.
 *
 * @throws {Error} On an unknown zone code, a feature that reaches no cell, a feature count that disagrees with the
 *   source's own declaration, or an area total that disagrees with the source's.
 */
export async function buildFloodDatabase(options: BuildFloodOptions): Promise<BuildFloodResult> {
	if (options.coverageResolution >= options.indexResolution) {
		throw new Error(
			`flood build: the coverage resolution (${options.coverageResolution}) must be coarser than the index resolution (${options.indexResolution}) — a row's coverage cell is the PARENT of its index cell`
		)
	}

	const { source } = options

	options.onProgress?.(
		`source: ${source.layer} · EPSG:${source.epsg} · ${source.declaredFeatureCount.toLocaleString()} features · ${source.origin}`
	)

	if (options.expectedFeatureCount !== undefined && options.expectedFeatureCount !== source.declaredFeatureCount) {
		throw new Error(
			`flood build: the source declares ${source.declaredFeatureCount} features and the live service reports ${options.expectedFeatureCount} — the archive is a different vintage from the one the service is publishing`
		)
	}

	const tmpPath = `${options.out}.tmp-${process.pid}`
	const database = new DatabaseSync(tmpPath)
	const kdb = new DatabaseClient<FloodDatabase>({ database })

	try {
		database.exec("PRAGMA journal_mode = OFF")
		database.exec("PRAGMA synchronous = OFF")

		await createFloodTables(kdb)
		await createLayerManifestTable(kdb)
		await createLayerCoverageTable(kdb)

		// The touch table exists only for this build and is dropped before the artifact is sealed. No primary key while
		// loading: the resolution queries below read it through indexes created once the load is done, and a clustered
		// key would sort every insert against an ingest order nothing controls.
		database.exec(
			"CREATE TABLE build_cell_touch (h3_cell INTEGER NOT NULL, resolution INTEGER NOT NULL, zone_code TEXT NOT NULL, area_id TEXT NOT NULL, is_full INTEGER NOT NULL)"
		)

		const streamed = await streamFeatures(database, options)

		options.onProgress?.(`${streamed.features.toLocaleString()} features written · resolving cells`)

		const cells = resolveCells(database)

		options.onProgress?.(
			`${cells.wholeRows.toLocaleString()} whole (compacted) · ${cells.partialRows.toLocaleString()} partial · ${cells.candidateRows.toLocaleString()} candidate pairs`
		)

		const coverage = buildCoverageCells(options.extent, streamed.observedByCoverageCell)

		await writeLayerCoverage(kdb, coverage)

		writeExtentRow(database, options, coverage.length)
		writeVocabularyRows(database)

		await writeLayerManifest(kdb, {
			name: EA_FLOOD_LAYER_NAME,
			version: options.sourceVintage,
			schemaVersion: FLOOD_SCHEMA_VERSION,
			tier: LayerTier.Shipped,
			license: EA_FLOOD_LICENSE,
			attribution: EA_FLOOD_ATTRIBUTION,
			source: `environment.data.gov.uk/dataset/${EA_FLOOD_DATASET_ID}`,
			sourceVintage: options.sourceVintage,
			buildCmd: options.buildCmd,
			buildSHA: options.buildSHA,
			freshnessPolicy: LayerFreshnessPolicy.VersionedRefresh,
			spineKeys: {
				h3: { column: "flood_zone_cell.h3_cell", resolution: options.indexResolution },
			},
			createdAt: options.createdAt,
		})

		database.exec("DROP TABLE build_cell_touch")
		database.exec("VACUUM")

		await kdb.destroy()

		sealDatabase(tmpPath)
		swapDatabaseIntoPlace(tmpPath, options.out)

		const totalCellRows = cells.wholeRows + cells.partialRows

		return {
			out: options.out,
			features: streamed.features,
			zoneCounts: streamed.zoneCounts,
			indexResolution: options.indexResolution,
			coverageResolution: options.coverageResolution,
			wholeCellRows: cells.wholeRows,
			partialCellRows: cells.partialRows,
			candidateRows: cells.candidateRows,
			storedPartialShare: totalCellRows ? cells.partialRows / totalCellRows : 0,
			coarsenedFeatures: streamed.coarsened,
			storedResolutions: cells.resolutions,
			coverageCells: coverage.length,
			coverageCellsWithRows: coverage.filter((cell) => cell.observedRows > 0).length,
			area: streamed.area,
			sizeBytes: sizeOf(options.out),
		}
	} catch (error) {
		await kdb.destroy().catch(() => undefined)

		throw error
	}
}

/**
 * What one streaming pass produced.
 */
interface StreamResult {
	features: number
	coarsened: number
	zoneCounts: Record<string, number>
	observedByCoverageCell: Map<number, number>
	area: BuildFloodResult["area"]
}

/**
 * Square metres in a square kilometre.
 */
const M2_PER_KM2 = 1_000_000

/**
 * Features between progress reports.
 */
const PROGRESS_STRIDE = 50_000

/**
 * Stream every feature into `flood_zone_area` and `build_cell_touch`.
 */
async function streamFeatures(database: DatabaseSync, options: BuildFloodOptions): Promise<StreamResult> {
	const declaredFeatureCount = options.source.declaredFeatureCount

	const insertArea = database.prepare(
		"INSERT INTO flood_zone_area (area_id, zone_code, zone_subtype, zone_source, origin, panel_id, effective_date, min_lat, min_lon, max_lat, max_lon, rings) " +
			"VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)"
	)

	const insertTouch = database.prepare(
		"INSERT INTO build_cell_touch (h3_cell, resolution, zone_code, area_id, is_full) VALUES (?, ?, ?, ?, ?)"
	)

	const zoneCounts: Record<string, number> = {}
	const observedByCoverageCell = new Map<number, number>()

	let features = 0
	let pending = 0
	let coarsened = 0
	let sourceArea = 0
	let nestedArea = 0
	let allExteriorArea = 0

	database.exec("BEGIN")

	try {
		for await (const feature of options.source.features()) {
			if (!EA_FLOOD_ZONE_CODES.has(feature.zoneCode)) {
				throw new Error(
					`flood build: feature ${feature.areaID} carries zone code ${JSON.stringify(feature.zoneCode)}, which is not in the authority's declared domain (${[...EA_FLOOD_ZONE_CODES].join(", ")}) — an unknown code is a source-schema change, and coercing it would turn "the source changed" into "there is nothing here"`
				)
			}

			const bbox = boundsOf(feature.polygons)
			const areas = ringAreaReadings(feature.polygons)

			sourceArea += feature.sourceAreaM2
			nestedArea += areas.nested
			allExteriorArea += areas.allExterior

			insertArea.run(
				feature.areaID,
				feature.zoneCode,
				feature.zoneSource,
				feature.origin,
				bbox.minLat,
				bbox.minLon,
				bbox.maxLat,
				bbox.maxLon,
				encodeRings(feature.polygons)
			)

			const classified = classifyFeatureCells(feature.polygons, options.indexResolution, feature.areaID)

			if (classified.resolution !== options.indexResolution) {
				coarsened++
			}

			const coverageCells = new Set<number>()

			for (const cell of classified.whole) {
				insertTouch.run(shortCellToInt(cell), classified.resolution, feature.zoneCode, feature.areaID, 1)
				addCoverageCells(coverageCells, cell, classified.resolution, options.coverageResolution)
			}

			for (const cell of classified.partial) {
				insertTouch.run(shortCellToInt(cell), classified.resolution, feature.zoneCode, feature.areaID, 0)
				addCoverageCells(coverageCells, cell, classified.resolution, options.coverageResolution)
			}

			for (const coverageCell of coverageCells) {
				observedByCoverageCell.set(coverageCell, (observedByCoverageCell.get(coverageCell) ?? 0) + 1)
			}

			zoneCounts[feature.zoneCode] = (zoneCounts[feature.zoneCode] ?? 0) + 1

			features++

			pending++

			if (pending >= INSERT_TRANSACTION_ROWS) {
				database.exec("COMMIT")
				database.exec("BEGIN")

				pending = 0
			}

			if (features % PROGRESS_STRIDE === 0) {
				options.onProgress?.(`${features.toLocaleString()} / ${declaredFeatureCount.toLocaleString()} features`)
			}
		}

		database.exec("COMMIT")
	} catch (error) {
		database.exec("ROLLBACK")

		throw error
	}

	if (features !== declaredFeatureCount) {
		throw new Error(
			`flood build: streamed ${features} features, the source declares ${declaredFeatureCount} — a short read builds a smaller England and reports success`
		)
	}

	const relativeGap = sourceArea ? Math.abs(nestedArea - sourceArea) / sourceArea : 0

	if (relativeGap > AREA_TOLERANCE) {
		throw new Error(
			`flood build: the encoded rings total ${(nestedArea / M2_PER_KM2).toFixed(1)} km² against the source's ${(sourceArea / M2_PER_KM2).toFixed(1)} km² ` +
				`(${(relativeGap * 100).toFixed(2)}% apart, tolerance ${(AREA_TOLERANCE * 100).toFixed(0)}%). Read without their holes the same rings total ` +
				`${(allExteriorArea / M2_PER_KM2).toFixed(1)} km², so compare the two: a hole-blind read answers "inside" for every point in a hole`
		)
	}

	return {
		features,
		coarsened,
		zoneCounts,
		observedByCoverageCell,
		area: {
			sourceKM2: sourceArea / M2_PER_KM2,
			nestedKM2: nestedArea / M2_PER_KM2,
			allExteriorKM2: allExteriorArea / M2_PER_KM2,
			relativeGap,
		},
	}
}

/**
 * Resolve the touch table into the two stored cell tiers.
 *
 * Compaction happens HERE and only on the whole side. A zone's uniform interior collapses parent-ward into a handful of
 * coarse cells while the fringe stays fine — hierarchy-respecting run-length encoding. A partial cell's parent is not
 * partial in any useful sense, so compacting the fringe would claim it covers ground it does not.
 */
function resolveCells(database: DatabaseSync): {
	wholeRows: number
	partialRows: number
	candidateRows: number
	resolutions: number[]
} {
	database.exec("CREATE INDEX build_cell_touch_zone_cell ON build_cell_touch (zone_code, h3_cell, is_full)")

	const zones = database
		.prepare("SELECT DISTINCT zone_code, resolution FROM build_cell_touch ORDER BY zone_code, resolution")
		.all() as Array<{ zone_code: string; resolution: number }>

	const insertCell = database.prepare(
		"INSERT INTO flood_zone_cell (h3_cell, resolution, zone_code, containment) VALUES (?, ?, ?, ?)"
	)

	const resolutions = new Set<number>()

	let wholeRows = 0
	let partialRows = 0

	// One group per (zone, resolution): `compactCells` takes a single resolution, and an adaptively-indexed layer has
	// several. Pooling them throws; compacting only the target group would silently drop every coarsened feature's
	// interior — the shape of failure this repo keeps writing down, because the artifact would still build.
	for (const { zone_code: zoneCode, resolution } of zones) {
		const wholeShort = database
			.prepare("SELECT DISTINCT h3_cell FROM build_cell_touch WHERE zone_code = ? AND resolution = ? AND is_full = 1")
			.all(zoneCode, resolution) as Array<{ h3_cell: number }>

		const compacted = compactCells(wholeShort.map((row) => shortCellToLong(row.h3_cell, resolution)))

		database.exec("BEGIN")

		for (const cell of compacted) {
			const cellResolution = getResolution(cell)

			resolutions.add(cellResolution)
			insertCell.run(shortCellToInt(cell as H3Cell), cellResolution, zoneCode, FloodCellContainment.Whole)

			wholeRows++
		}

		database.exec("COMMIT")

		const partial = database
			.prepare(
				"SELECT DISTINCT t.h3_cell FROM build_cell_touch t WHERE t.zone_code = ? AND t.resolution = ? AND NOT EXISTS (" +
					"SELECT 1 FROM build_cell_touch f WHERE f.zone_code = t.zone_code AND f.h3_cell = t.h3_cell AND f.is_full = 1)"
			)
			.all(zoneCode, resolution) as Array<{ h3_cell: number }>

		database.exec("BEGIN")

		for (const row of partial) {
			resolutions.add(resolution)
			insertCell.run(row.h3_cell, resolution, zoneCode, FloodCellContainment.Partial)

			partialRows++
		}

		database.exec("COMMIT")
	}

	// The candidate list exists for the fringe only: a whole cell is answered by `flood_zone_cell` alone, so carrying its
	// polygons would store the geometry join for every interior cell in England to no purpose.
	database.exec(
		"INSERT INTO flood_zone_cell_area (h3_cell, resolution, area_id) " +
			"SELECT DISTINCT t.h3_cell, t.resolution, t.area_id FROM build_cell_touch t " +
			"WHERE EXISTS (SELECT 1 FROM flood_zone_cell c WHERE c.h3_cell = t.h3_cell AND c.zone_code = t.zone_code AND c.containment = 'partial')"
	)

	const candidateRows = (database.prepare("SELECT count(*) AS n FROM flood_zone_cell_area").get() as { n: number }).n

	return {
		wholeRows,
		partialRows,
		candidateRows,
		resolutions: [...resolutions].toSorted((left, right) => left - right),
	}
}

/**
 * Record the coverage cells one index cell falls in.
 *
 * A row's coverage cell is `cellToParent` of its finer cell, never a fresh `latLngToCell` at the coarse resolution —
 * every existing reader in this repo derives it that way. An adaptively-coarsened cell can be COARSER than the coverage
 * resolution, in which case it spans several coverage cells and every one of them is recorded: a coarse cell counted
 * against one arbitrary child would leave the others reading as empty.
 */
function addCoverageCells(into: Set<number>, cell: H3Cell, cellResolution: number, coverageResolution: number): void {
	if (cellResolution === coverageResolution) {
		into.add(shortCellToInt(cell))

		return
	}

	if (cellResolution > coverageResolution) {
		into.add(shortCellToInt(cellToParent(cell, coverageResolution) as H3Cell))

		return
	}

	for (const child of cellToChildren(cell, coverageResolution)) {
		into.add(shortCellToInt(child as H3Cell))
	}
}

/**
 * The full H3 index for a short cell stored at `resolution`.
 *
 * Through `expandH3Cell` rather than a string concatenation, because it VALIDATES: a short cell that does not name a
 * valid cell at the stated resolution throws here instead of reaching `compactCells` as a plausible-looking index.
 */
function shortCellToLong(shortCell: number, resolution: number): string {
	return expandH3Cell(shortCell.toString(16).padStart(13, "0") as H3CellShort, resolution)
}

/**
 * The coverage rows: one per interior cell of the authority's footprint, and none outside it.
 *
 * `observed_rows` counts the polygons reaching into the cell, which is what the contract's column means. It is ZERO for
 * a cell the authority designated and no polygon covers — the storable form of the Zone 1 designation, and the row a
 * reader must not confuse with the absent row a cell outside England has.
 */
function buildCoverageCells(extent: FloodMapExtent, observed: Map<number, number>): CoverageCell[] {
	const cells: CoverageCell[] = []

	for (const h3Cell of extent.coverageCells) {
		cells.push({
			h3Cell,
			completeness: 1,
			basis: CoverageBasis.Designated,
			observedRows: observed.get(h3Cell) ?? 0,
		})
	}

	return cells.toSorted((left, right) => left.h3Cell - right.h3Cell)
}

/**
 * Insert the single footprint row.
 */
function writeExtentRow(database: DatabaseSync, options: BuildFloodOptions, coverageCells: number): void {
	const { extent } = options

	database
		.prepare(
			"INSERT INTO flood_map_extent (extent_id, status, authority, statement, statement_url, boundary_source, boundary_source_url, boundary_vintage, boundary_license, effective_date, min_lat, min_lon, max_lat, max_lon, coverage_cells, coverage_resolution) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
		)
		.run(
			extent.extentID,
			extent.status,
			extent.authority,
			extent.statement,
			extent.statementURL,
			extent.boundary.source,
			extent.boundary.sourceURL,
			extent.boundary.vintage,
			extent.boundary.license,
			options.sourceVintage,
			extent.bbox.minLat,
			extent.bbox.minLon,
			extent.bbox.maxLat,
			extent.bbox.maxLon,
			coverageCells,
			extent.coverageResolution
		)
}

/**
 * Insert the authority's declared zone domain.
 */
function writeVocabularyRows(database: DatabaseSync): void {
	const insert = database.prepare(
		"INSERT INTO flood_zone_vocabulary (zone_code, label, definition, definition_url) VALUES (?, ?, ?, ?)"
	)

	for (const zone of EA_FLOOD_ZONE_DEFINITIONS) {
		insert.run(zone.code, zone.label, zone.definition, zone.definitionURL)
	}
}

/**
 * The bounding rectangle of one feature's rings — the ray cast's prefilter, precomputed.
 */
function boundsOf(polygons: ReadonlyArray<ReadonlyArray<ReadonlyArray<readonly number[]>>>): {
	minLat: number
	minLon: number
	maxLat: number
	maxLon: number
} {
	let minLat = Infinity
	let minLon = Infinity
	let maxLat = -Infinity
	let maxLon = -Infinity

	for (const rings of polygons) {
		for (const ring of rings) {
			for (const position of ring) {
				const lon = position[0]!
				const lat = position[1]!

				if (lon < minLon) {
					minLon = lon
				}

				if (lon > maxLon) {
					maxLon = lon
				}

				if (lat < minLat) {
					minLat = lat
				}

				if (lat > maxLat) {
					maxLat = lat
				}
			}
		}
	}

	return { minLat, minLon, maxLat, maxLon }
}

/**
 * The artifact's size on disk, read once for the receipt.
 */
function sizeOf(path: string): number {
	return statSync(path).size
}
