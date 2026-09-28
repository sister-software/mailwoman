/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The authority's mapped footprint determines which cells may receive a `designated` coverage claim.
 *
 *   The footprint encodes the coverage statement for each affected cell. The EA states that the Flood Zone
 *   mapping "covers all of England". Zone 1 is land outside Zones 2 and 3. The hazard polygons therefore omit
 *   Zone 1. A footprint built from those polygons would report every Zone 1 location as unmapped. That would
 *   reverse the coverage result this layer must provide.
 *
 *   The flood authority does not publish an England boundary. The national statistical authority's country
 *   boundary supplies the outline needed to convert the coverage statement into cells. `flood_map_extent` records
 *   that artifact. The coverage claim depends on the outline used for clipping.
 *
 *   The clip is conservative. `interiorCoverageCellSet` keeps only cells that lie wholly inside the outline.
 *   England–Wales and England–Scotland border strips receive no coverage row. A point there reads unknown
 *   because the EA's statement may not cover it. Marking a cell as interior would claim that the authority
 *   determined coverage for a location it did not assess.
 */

import { interiorCoverageCellSet, type ParsedGeometry } from "@mailwoman/spatial"

import {
	ONS_BOUNDARY_ATTRIBUTION,
	ONS_BOUNDARY_BASE_URL,
	ONS_BOUNDARY_LICENSE,
	ONS_BOUNDARY_PRODUCT,
} from "#sdk/client"

/**
 * The country the EA's coverage statement names.
 */
export const EA_COVERAGE_COUNTRY = "England"

/**
 * The `extent_id` of the EA's single footprint row.
 */
export const EA_EXTENT_ID = "ea-england"

/**
 * `flood_map_extent.status` for a footprint an authority states it has mapped.
 *
 * A source publishing its own availability categories writes those instead —
 * fema's availability layer distinguishes "Digital Data Available", "No Digital Data
 * Available" and "Unmapped", and folding three published categories into one would
 * discard the distinction that makes its coverage rows meaningful.
 */
export const FLOOD_EXTENT_STATUS_MAPPED = "mapped"

/**
 * The boundary artifact used to clip a footprint and the artifact's terms.
 */
export interface BoundaryProvenance {
	source: string
	sourceURL: string
	vintage: string
	license: string
	attribution: string
}

/**
 * The default boundary provenance: the ONS Open Geography country product `client.ts` reads.
 */
export const ONS_ENGLAND_PROVENANCE: BoundaryProvenance = {
	source: `Office for National Statistics — ${ONS_BOUNDARY_PRODUCT}`,
	sourceURL: ONS_BOUNDARY_BASE_URL,
	vintage: "2025-12",
	license: ONS_BOUNDARY_LICENSE,
	attribution: ONS_BOUNDARY_ATTRIBUTION,
}

/**
 * One realized footprint, including its outline and provenance.
 * It also lists eligible coverage cells.
 */
export interface FloodMapExtent {
	extentID: string
	status: string
	authority: string
	statement: string
	statementURL: string
	boundary: BoundaryProvenance
	geometry: ParsedGeometry
	bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }
	/**
	 * Short-cell integers at {@link FloodMapExtent.coverageResolution}, every one wholly inside the outline.
	 */
	coverageCells: Set<number>
	coverageResolution: number
}

export interface RealizeExtentOptions {
	geometry: ParsedGeometry
	coverageResolution: number
	authority: string
	statement: string
	statementURL: string
	boundary?: BoundaryProvenance
	extentID?: string
	status?: string
}

/**
 * Pull the outline out of whatever a boundary file actually holds: a bare geometry,
 * a `Feature` wrapping one, or a `FeatureCollection`.
 *
 * A collection must contain exactly one feature.
 * Every export tool writes a `FeatureCollection`, so refusing the shape outright would
 * refuse the ordinary case, but taking the first of several would silently choose
 * which country the coverage claim describes.
 * The claim depends on the outline used for clipping.
 *
 * @throws {TypeError} When the document holds no geometry, or a collection
 * holds anything other than one feature.
 */
export function outlineFromGeoJSON(document: unknown, origin: string): ParsedGeometry {
	const node = document as {
		type?: string
		geometry?: unknown
		coordinates?: unknown
		features?: Array<{ geometry?: unknown }>
	}

	if (node.type === "FeatureCollection") {
		const features = node.features ?? []

		if (features.length !== 1) {
			throw new TypeError(
				`flood extent: ${origin} holds ${features.length} features — a boundary file must name exactly one outline, because taking the first would silently choose which area the coverage claim is about`
			)
		}

		return outlineFromGeoJSON(features[0], origin)
	}

	if (node.geometry) return node.geometry as ParsedGeometry

	if (node.coordinates) return node as ParsedGeometry

	throw new TypeError(`flood extent: ${origin} carries no geometry`)
}

/**
 * Turn an outline plus a coverage statement into a footprint.
 *
 * @throws {Error} When the outline yields no interior cell at `coverageResolution`.
 * The resolution is coarser than the outline.
 * A zero-cell footprint would write no coverage rows.
 * An artifact that answers "unknown" everywhere while reporting a successful build.
 */
export function realizeFloodMapExtent(options: RealizeExtentOptions): FloodMapExtent {
	const coverageCells = interiorCoverageCellSet(options.geometry, options.coverageResolution)

	if (!coverageCells.size) {
		throw new Error(
			`flood extent: the outline yields no interior cell at resolution ${options.coverageResolution} — the artifact would carry no coverage rows and answer "unknown" everywhere while reporting success`
		)
	}

	return {
		extentID: options.extentID ?? EA_EXTENT_ID,
		status: options.status ?? FLOOD_EXTENT_STATUS_MAPPED,
		authority: options.authority,
		statement: options.statement,
		statementURL: options.statementURL,
		boundary: options.boundary ?? ONS_ENGLAND_PROVENANCE,
		geometry: options.geometry,
		bbox: geometryBounds(options.geometry),
		coverageCells,
		coverageResolution: options.coverageResolution,
	}
}

/**
 * The outline's bounding rectangle, holes included.
 *
 * A coarse descriptor for the receipt, never the footprint itself.
 */
function geometryBounds(geometry: ParsedGeometry): {
	minLat: number
	minLon: number
	maxLat: number
	maxLon: number
} {
	let minLat = Infinity
	let minLon = Infinity
	let maxLat = -Infinity
	let maxLon = -Infinity

	const walk = (node: unknown): void => {
		if (!Array.isArray(node)) return

		if (typeof node[0] === "number" && typeof node[1] === "number") {
			const lon = node[0]
			const lat = node[1]

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

			return
		}

		for (const child of node) {
			walk(child)
		}
	}

	walk((geometry as { coordinates?: unknown }).coordinates)

	if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) {
		throw new TypeError("flood extent: the outline carries no coordinates to bound")
	}

	return { minLat, minLon, maxLat, maxLon }
}
