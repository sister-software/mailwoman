/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the sealed undersea layer database and Earth's browser asset from one gazetteer download.
 *
 *   The build reads the three GeoJSON files a download wrote, checks each against the download's receipt,
 *   and writes one row per record and geometry kind. A record without a name, a generic term or an id is
 *   left out and counted. The result reports the source's record count and the layer's row count per kind.
 *
 *   Coverage rows use the `source_present` basis. A cell holds a row when a gazetteer feature's label point
 *   lies in it. The gazetteer lists only the features a naming authority accepted, so a cell without a row
 *   leaves open whether the sea floor there has features.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, removePath, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import {
	createLayerCoverageTable,
	createLayerManifestTable,
	sourcePresentCoverageCells,
	writeLayerCoverage,
	writeLayerManifest,
} from "@mailwoman/core/layers"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { pointInPolygon } from "@mailwoman/spatial/geometries/polygon"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed/db"
import { cellToParent, latLngToCell } from "@sister.software/h3"
import { dirname, type PathBuilder } from "path-ts"

import type { UnderseaAsset, UnderseaAssetFeature, UnderseaBBox } from "#features"
import { underseaNameKey } from "#features"
import { createUnderseaTables, UNDERSEA_H3_RESOLUTION, type UnderseaDatabase } from "#schema"
import type { UnderseaDownloadReceipt, UnderseaSourceFeature } from "#sdk/download"
import { type DepthSampleRequest, depthKindOf } from "#tools/depth"
import type { UnderseaGeometryKind } from "#vocabulary"
import {
	UNDERSEA_ATTRIBUTION,
	UNDERSEA_LAYER_NAME,
	UNDERSEA_LICENSE,
	UNDERSEA_SCHEMA_VERSION,
	underseaDisplayName,
} from "#vocabulary"

/**
 * The H3 resolution of the coverage rows.
 */
export const UNDERSEA_COVERAGE_RESOLUTION = 3

/**
 * Decimal places kept for a coordinate in the browser asset, about 11 m at the equator.
 */
const ASSET_COORDINATE_DECIMALS = 4

type Position = [lon: number, lat: number]

/**
 * What one build reads and writes.
 */
export interface UnderseaBuildOptions {
	/**
	 * The download directory, holding `receipt.json` and the three GeoJSON files.
	 */
	sourceDirectory: PathBuilder
	/**
	 * The database path the build swaps its result into.
	 */
	out: string
	/**
	 * The browser asset's path.
	 */
	assetOut: string
	createdAt: string
	buildSHA: string
	buildCmd: string
	/**
	 * Reads each feature's depth from the terrain tiles.
	 *
	 * Absent, every depth is `null`, which a test uses to build without the network.
	 */
	readDepths?: (requests: ReadonlyArray<DepthSampleRequest | null>) => Promise<Array<number | null>>
	log?: (line: string) => void
}

/**
 * What a build counted, per geometry kind.
 */
export interface UnderseaBuildResult {
	out: string
	assetOut: string
	sourceVintage: string
	/**
	 * Records each service layer held.
	 */
	sourceRecords: Record<UnderseaGeometryKind, number>
	/**
	 * Records written to the database.
	 */
	written: Record<UnderseaGeometryKind, number>
	/**
	 * Records left out for a missing name, generic term, id or geometry.
	 */
	skipped: Record<UnderseaGeometryKind, number>
	coverageCells: number
	/**
	 * Rows given a depth, out of the rows whose generic term has one.
	 */
	depths: { read: number; eligible: number }
}

/**
 * One record reduced to the columns and the asset feature the build writes.
 */
export interface UnderseaReducedRecord {
	featureID: number
	kind: UnderseaGeometryKind
	name: string
	genericTerm: string
	displayName: string
	labelPoint: Position
	bbox: UnderseaBBox
	/**
	 * The asset's geometry: the longest part of a line, or the label point.
	 */
	assetGeometry: UnderseaAssetFeature["geometry"]
	sourceGeometry: string
	/**
	 * Where the build reads the feature's depth: a point's label point, a line's vertices,
	 * or a grid of points inside a polygon with its label point.
	 */
	depthSamples: Position[]
}

/**
 * The most vertices of one line the depth read samples.
 * A longer line is sampled at even steps.
 */
const MAX_LINE_DEPTH_SAMPLES = 120

/**
 * The grid laid over a polygon's bounding box for its depth samples, per side.
 */
const POLYGON_DEPTH_GRID = 6

/**
 * Up to {@link MAX_LINE_DEPTH_SAMPLES} vertices of a line, at even steps.
 */
function lineDepthSamples(line: readonly Position[]): Position[] {
	const step = Math.max(1, Math.ceil(line.length / MAX_LINE_DEPTH_SAMPLES))

	return line.filter((_, index) => index % step === 0)
}

/**
 * The points of a {@link POLYGON_DEPTH_GRID} grid that lie inside the polygon, with its label point.
 */
function polygonDepthSamples(rings: Position[][], labelPoint: Position): Position[] {
	const [west, south, east, north] = bboxOf(rings[0]!)
	const samples: Position[] = [labelPoint]

	for (let row = 0; row < POLYGON_DEPTH_GRID; row++) {
		for (let column = 0; column < POLYGON_DEPTH_GRID; column++) {
			const lon = west + ((column + 0.5) / POLYGON_DEPTH_GRID) * (east - west)
			const lat = south + ((row + 0.5) / POLYGON_DEPTH_GRID) * (north - south)

			if (pointInPolygon(lon, lat, rings)) {
				samples.push([lon, lat])
			}
		}
	}

	return samples
}

const round = (value: number) => Number(value.toFixed(ASSET_COORDINATE_DECIMALS))
const roundPosition = ([lon, lat]: Position): Position => [round(lon), round(lat)]

/**
 * The bounding box of a set of positions.
 */
function bboxOf(positions: readonly Position[]): UnderseaBBox {
	let west = Infinity
	let south = Infinity
	let east = -Infinity
	let north = -Infinity

	for (const [lon, lat] of positions) {
		west = Math.min(west, lon)
		south = Math.min(south, lat)
		east = Math.max(east, lon)
		north = Math.max(north, lat)
	}

	return [west, south, east, north]
}

/**
 * The length of a line in degrees, used only to pick the longest part of a multi-part line.
 */
function lineLength(line: readonly Position[]): number {
	let length = 0

	for (let index = 1; index < line.length; index++) {
		length += Math.hypot(line[index]![0] - line[index - 1]![0], line[index]![1] - line[index - 1]![1])
	}

	return length
}

/**
 * The shoelace area of a ring in square degrees, used only to pick the largest ring.
 */
function ringArea(ring: readonly Position[]): number {
	let sum = 0

	for (let index = 0; index < ring.length; index++) {
		const [x1, y1] = ring[index]!
		const [x2, y2] = ring[(index + 1) % ring.length]!

		sum += x1 * y2 - x2 * y1
	}

	return Math.abs(sum / 2)
}

/**
 * A point inside a polygon for its label.
 *
 * The bounding-box center is taken when the polygon contains it.
 * Otherwise the scan walks the horizontal line through the center and takes
 * the middle of the widest interior span.
 *
 * That point lies inside any polygon the line crosses.
 * The ring's first vertex is the last resort.
 */
function polygonLabelPoint(rings: Position[][]): Position {
	const [west, south, east, north] = bboxOf(rings[0]!)
	const center: Position = [(west + east) / 2, (south + north) / 2]

	if (pointInPolygon(center[0], center[1], rings)) return center

	const crossings: number[] = []

	for (const ring of rings) {
		for (let index = 0; index < ring.length; index++) {
			const [x1, y1] = ring[index]!
			const [x2, y2] = ring[(index + 1) % ring.length]!

			if (y1 > center[1] !== y2 > center[1]) {
				crossings.push(x1 + ((center[1] - y1) / (y2 - y1)) * (x2 - x1))
			}
		}
	}

	crossings.sort((left, right) => left - right)

	let best: Position | null = null
	let widest = 0

	for (let index = 0; index + 1 < crossings.length; index += 2) {
		const width = crossings[index + 1]! - crossings[index]!

		if (width > widest) {
			widest = width
			best = [(crossings[index]! + crossings[index + 1]!) / 2, center[1]]
		}
	}

	return best ?? rings[0]![0]!
}

/**
 * Reduces one source record, or returns `null` when it lacks a name, generic term, id or geometry.
 */
export function reduceUnderseaRecord(
	feature: UnderseaSourceFeature,
	kind: UnderseaGeometryKind
): UnderseaReducedRecord | null {
	const { NAME, TYPE, FEATURE_ID } = feature.properties
	const geometry = feature.geometry

	if (!NAME?.trim() || !TYPE?.trim() || typeof FEATURE_ID !== "number" || !geometry) return null

	const base = {
		featureID: FEATURE_ID,
		kind,
		name: NAME.trim(),
		genericTerm: TYPE.trim(),
		displayName: underseaDisplayName(NAME, TYPE),
		sourceGeometry: stringifyJSON(geometry),
	}

	if (geometry.type === "Point" || geometry.type === "MultiPoint") {
		const points = (geometry.type === "Point" ? [geometry.coordinates] : geometry.coordinates) as Position[]

		if (!points.length) return null

		const labelPoint = points[0]!

		return {
			...base,
			labelPoint,
			bbox: bboxOf(points),
			assetGeometry: { type: "Point", coordinates: roundPosition(labelPoint) },
			depthSamples: points,
		}
	}

	if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
		const parts = (geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates) as Position[][]
		const longest = parts.toSorted((left, right) => lineLength(right) - lineLength(left))[0]

		if (!longest?.length) return null

		const labelPoint = longest[Math.floor(longest.length / 2)]!

		return {
			...base,
			labelPoint,
			bbox: bboxOf(parts.flat()),
			assetGeometry: { type: "LineString", coordinates: longest.map(roundPosition) },
			depthSamples: parts.flatMap(lineDepthSamples),
		}
	}

	if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
		const polygons = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as Position[][][]
		const largest = polygons.toSorted((left, right) => ringArea(right[0] ?? []) - ringArea(left[0] ?? []))[0]

		if (!largest?.[0]?.length) return null

		const labelPoint = polygonLabelPoint(largest)

		return {
			...base,
			labelPoint,
			bbox: bboxOf(polygons.flatMap((polygon) => polygon[0] ?? [])),
			assetGeometry: { type: "Point", coordinates: roundPosition(labelPoint) },
			depthSamples: polygonDepthSamples(largest, labelPoint),
		}
	}

	return null
}

const emptyCounts = (): Record<UnderseaGeometryKind, number> => ({ point: 0, line: 0, polygon: 0 })

/**
 * Builds the database and the browser asset, swaps the database into place and seals it.
 *
 * @throws When a source file's digest or record count differs from its receipt.
 * The output path keeps whatever it held before.
 */
export async function buildUnderseaLayer(options: UnderseaBuildOptions): Promise<UnderseaBuildResult> {
	const log = options.log ?? (() => {})
	const receipt = await readLocalJSONFile<UnderseaDownloadReceipt>(options.sourceDirectory("receipt.json"))
	const sourceRecords = emptyCounts()
	const written = emptyCounts()
	const skipped = emptyCounts()
	const records: UnderseaReducedRecord[] = []

	for (const layer of receipt.layers) {
		const path = options.sourceDirectory(layer.file)
		const digest = await sha256File(path)

		if (digest !== layer.sha256) {
			throw new Error(`undersea build: ${path} has SHA-256 ${digest}, and the receipt records ${layer.sha256}`)
		}

		const collection = await readLocalJSONFile<{ features: UnderseaSourceFeature[] }>(path)

		if (collection.features.length !== layer.count) {
			throw new Error(
				`undersea build: ${path} holds ${collection.features.length} features, and the receipt records ${layer.count}`
			)
		}

		sourceRecords[layer.kind] = layer.count

		for (const feature of collection.features) {
			const reduced = reduceUnderseaRecord(feature, layer.kind)

			if (reduced) {
				records.push(reduced)
			} else {
				skipped[layer.kind]++
			}
		}
	}

	// The service can list one record twice in a layer.
	// The build keeps the first copy.
	const unique: UnderseaReducedRecord[] = []
	const keys = new Set<string>()

	for (const record of records) {
		const key = `${record.featureID}:${record.kind}`

		if (keys.has(key)) {
			skipped[record.kind]++

			continue
		}

		keys.add(key)
		unique.push(record)
	}

	const depthKinds = unique.map((record) => depthKindOf(record.genericTerm))

	const requests = unique.map((record, index): DepthSampleRequest | null => {
		const kind = depthKinds[index]

		return kind ? { positions: record.depthSamples, window: record.kind !== "polygon", kind } : null
	})

	const depths = options.readDepths ? await options.readDepths(requests) : requests.map(() => null)

	if (depths.length !== unique.length) {
		throw new Error(`undersea build: the depth read returned ${depths.length} depths for ${unique.length} records`)
	}

	const tmp = `${options.out}.tmp-${process.pid}`

	await makeDirectories(dirname(options.out))

	if (await pathExists(tmp)) {
		await removePath(tmp)
	}

	const observed = new Map<number, number>()

	try {
		using db = new DatabaseClient<UnderseaDatabase>(tmp)

		await createUnderseaTables(db)
		await createLayerManifestTable(db)
		await createLayerCoverageTable(db)

		const insert = db.prepare(
			"INSERT INTO undersea_feature (feature_id, kind, name, generic_term, display_name, name_key, label_lon, " +
				"label_lat, h3_cell, min_lon, min_lat, max_lon, max_lat, geometry, depth_m, depth_kind) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
		)

		db.exec("BEGIN")

		for (const [index, record] of unique.entries()) {
			const depth = depths[index] ?? null
			const [lon, lat] = record.labelPoint
			const cell = latLngToCell(lat, lon, UNDERSEA_H3_RESOLUTION) as H3Cell
			const coverageCell = shortCellToInt(cellToParent(cell, UNDERSEA_COVERAGE_RESOLUTION) as H3Cell)

			observed.set(coverageCell, (observed.get(coverageCell) ?? 0) + 1)

			insert.run(
				record.featureID,
				record.kind,
				record.name,
				record.genericTerm,
				record.displayName,
				underseaNameKey(record.displayName),
				lon,
				lat,
				shortCellToInt(cell),
				...record.bbox,
				record.sourceGeometry,
				depth,
				depth === null ? null : (depthKinds[index] ?? null)
			)

			written[record.kind]++
		}

		db.exec("COMMIT")

		await writeLayerCoverage(db, sourcePresentCoverageCells(observed))

		await writeLayerManifest(db, {
			name: UNDERSEA_LAYER_NAME,
			version: receipt.sourceVintage,
			schemaVersion: UNDERSEA_SCHEMA_VERSION,
			tier: "shipped",
			license: UNDERSEA_LICENSE,
			attribution: UNDERSEA_ATTRIBUTION,
			source: receipt.serviceURL,
			sourceVintage: receipt.sourceVintage,
			buildCmd: options.buildCmd,
			buildSHA: options.buildSHA,
			freshnessPolicy: "versioned-refresh",
			spineKeys: { h3: { column: "undersea_feature.h3_cell", resolution: UNDERSEA_H3_RESOLUTION } },
			createdAt: options.createdAt,
			sourceRecords: { "IHO-IOC GEBCO": sourceRecords.point + sourceRecords.line + sourceRecords.polygon },
			sourceURL: receipt.serviceURL,
			sourceSHA256: null,
		})

		db.exec("ANALYZE")
	} catch (error) {
		await removePath(tmp).catch(() => {})

		throw error
	}

	await swapDatabaseIntoPlace(tmp, options.out)
	await sealDatabase(options.out)

	const asset: UnderseaAsset = {
		type: "FeatureCollection",
		attribution: UNDERSEA_ATTRIBUTION,
		sourceVintage: receipt.sourceVintage,
		features: unique.map((record, index) => {
			const depth = depths[index] ?? null

			return {
				type: "Feature" as const,
				id: record.featureID,
				geometry: record.assetGeometry,
				properties: {
					featureID: record.featureID,
					name: record.name,
					genericTerm: record.genericTerm,
					displayName: record.displayName,
					kind: record.kind,
					labelPoint: roundPosition(record.labelPoint),
					bbox: record.bbox.map(round) as UnderseaBBox,
					depthM: depth,
					depthKind: depth === null ? null : (depthKinds[index] ?? null),
				},
			}
		}),
	}

	// The asset is written compact, because every Earth visitor who searches downloads it.
	// `writeLocalJSONFile` writes a string argument as it is.
	await writeLocalJSONFile(stringifyJSON(asset), options.assetOut)

	log(
		`undersea: wrote ${written.point + written.line + written.polygon} rows (points ${written.point}, lines ${written.line}, polygons ${written.polygon}); skipped ${skipped.point + skipped.line + skipped.polygon}`
	)

	return {
		out: options.out,
		assetOut: options.assetOut,
		sourceVintage: receipt.sourceVintage,
		sourceRecords,
		written,
		skipped,
		coverageCells: observed.size,
		depths: {
			read: depths.filter((depth) => depth !== null).length,
			eligible: depthKinds.filter((kind) => kind !== null).length,
		},
	}
}
