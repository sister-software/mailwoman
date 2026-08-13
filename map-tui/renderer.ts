/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Viewport-to-braille-frame renderer for map-tui's debug view.
 *
 * `MapRenderer.renderFrame` is the package's single public entry point: given a `Viewport` (center lon/lat, zoom, cell
 * columns/rows), it fetches the covering tiles from a `TileSource`, rasterizes styled geometry (./style.ts,
 * ./raster.ts) into a subpixel RGBA grid, converts that grid to braille cells (./frame.ts), then overlays collected
 * labels and marker/ring annotations on top. Draw order is fill → line → label per the layer style table, with overlays
 * (ring, labels, markers) layered afterward in that order — markers deliberately skip the label collision bitmap so a
 * requested marker always wins the cell.
 */

import { type MapFrame, overlayText, rasterizeToFrame, rgbToPacked } from "./frame.ts"
import { lonLatToWorldPx, metersPerPixel, TILE_SIZE } from "./mercator.ts"
import type { DecodedFeature } from "./mvt.ts"
import { drawCircle, drawPolyline, fillPolygon, RGBAGrid } from "./raster.ts"
import { type LayerStyle, type RGB, stylesFor } from "./style.ts"
import type { DecodedTile, TileSource } from "./tile-source.ts"

export interface Viewport {
	centerLon: number
	centerLat: number
	zoom: number
	columns: number
	rows: number
}

export interface MarkerSpec {
	lon: number
	lat: number
	char?: string
	color?: RGB
}

export interface RingSpec {
	lon: number
	lat: number
	radiusMeters: number
}

const DEFAULT_MARKER_CHAR = "●"
const DEFAULT_MARKER_COLOR: RGB = [255, 80, 80]

/**
 * Subpixel dimensions per braille cell: 2 columns wide, 4 rows tall.
 */
const SUBPIXEL_COLUMNS_PER_CELL = 2
const SUBPIXEL_ROWS_PER_CELL = 4

/**
 * Minimum ring radius (in device pixels) worth drawing — smaller than this, the midpoint circle algorithm degenerates
 * to a single point or nothing useful.
 */
const MIN_RING_RADIUS_PX = 2

interface ProjectedPoint {
	x: number
	y: number
}

interface PendingLabel {
	text: string
	column: number
	row: number
	color: number
}

/**
 * Origin of the render's subpixel grid, in world (Mercator) pixels — everything projected onto the grid is offset by
 * this pair.
 */
interface GridOrigin {
	x: number
	y: number
}

/**
 * Everything a point projection needs, bundled so the per-feature rasterizers below take one parameter instead of four
 * — that's what keeps `rasterizeFeature` under `max-params` (8) once `style`, `renderZoom`, and `pendingLabels` join
 * it. Threaded through as a value rather than closed over so those rasterizers stay free functions (no nesting inside
 * `renderFrame` deep enough to trip `max-depth`).
 */
interface TileProjection {
	tileX: number
	tileY: number
	scale: number
	origin: GridOrigin
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max)
}

function projectPoint(projection: TileProjection, gx: number, gy: number): ProjectedPoint {
	return {
		x: projection.tileX * TILE_SIZE + gx * projection.scale - projection.origin.x,
		y: projection.tileY * TILE_SIZE + gy * projection.scale - projection.origin.y,
	}
}

function rasterizeFill(grid: RGBAGrid, feature: DecodedFeature, projection: TileProjection, color: RGB): void {
	const rings = feature.geometry.map((ring) => ring.map((point) => projectPoint(projection, point.x, point.y)))

	fillPolygon(grid, rings, color)
}

function rasterizeLine(
	grid: RGBAGrid,
	feature: DecodedFeature,
	projection: TileProjection,
	color: RGB,
	width: number
): void {
	for (const part of feature.geometry) {
		const points = part.map((point) => projectPoint(projection, point.x, point.y))

		drawPolyline(grid, points, color, width)
	}
}

function collectLabels(
	feature: DecodedFeature,
	property: string,
	color: RGB,
	projection: TileProjection,
	pendingLabels: PendingLabel[]
): void {
	const text = String(feature.properties[property] ?? "")

	if (!text.length) return

	const packedColor = rgbToPacked(color)

	for (const part of feature.geometry) {
		for (const point of part) {
			const projected = projectPoint(projection, point.x, point.y)

			pendingLabels.push({
				text,
				column: Math.floor(projected.x / SUBPIXEL_COLUMNS_PER_CELL),
				row: Math.floor(projected.y / SUBPIXEL_ROWS_PER_CELL),
				color: packedColor,
			})
		}
	}
}

/**
 * Rasterizes (or, for labels, collects) one feature under one style. The `style.kind` dispatch is the only branching
 * here — the actual per-kind work lives in {@link rasterizeFill}/{@link rasterizeLine}/{@link collectLabels} so this
 * stays a flat one-level `if`/`else` regardless of how deeply its caller is already nested.
 */
function rasterizeFeature(
	grid: RGBAGrid,
	feature: DecodedFeature,
	style: LayerStyle,
	renderZoom: number,
	projection: TileProjection,
	pendingLabels: PendingLabel[]
): void {
	if (style.kind === "fill") {
		rasterizeFill(grid, feature, projection, style.color)
	} else if (style.kind === "line") {
		rasterizeLine(grid, feature, projection, style.color, style.width(renderZoom))
	} else {
		collectLabels(feature, style.property, style.color, projection, pendingLabels)
	}
}

/**
 * Rasterizes every layer/style/feature in one tile matching `kind`. Pulled out of {@link MapRenderer.renderFrame} so
 * that method's own tile loop doesn't accumulate this function's three nested loops on top of its own.
 */
function rasterizeTileForKind(
	grid: RGBAGrid,
	tile: DecodedTile,
	tileX: number,
	tileY: number,
	kind: LayerStyle["kind"],
	renderZoom: number,
	origin: GridOrigin,
	pendingLabels: PendingLabel[]
): void {
	for (const layer of tile.layers) {
		const styles = stylesFor(layer.name, renderZoom).filter((style) => style.kind === kind)

		if (!styles.length) continue

		const projection: TileProjection = { tileX, tileY, scale: TILE_SIZE / layer.extent, origin }

		for (const style of styles) {
			for (const feature of layer.features) {
				rasterizeFeature(grid, feature, style, renderZoom, projection, pendingLabels)
			}
		}
	}
}

/**
 * Walks a viewport's rendering pipeline: tile fetch, style-ordered rasterization, braille conversion, then overlay
 * annotations (ring, labels, markers). One `MapRenderer` can render any number of viewports against the same
 * `TileSource` — it holds no per-frame state itself.
 */
export class MapRenderer {
	private readonly source: TileSource

	constructor(source: TileSource) {
		this.source = source
	}

	async renderFrame(viewport: Viewport, overlays?: { markers?: MarkerSpec[]; ring?: RingSpec }): Promise<MapFrame> {
		const { centerLon, centerLat, columns, rows } = viewport

		const subpixelW = columns * SUBPIXEL_COLUMNS_PER_CELL
		const subpixelH = rows * SUBPIXEL_ROWS_PER_CELL

		const renderZoom = clamp(Math.round(viewport.zoom), this.source.minZoom, this.source.maxZoom)
		const center = lonLatToWorldPx(centerLon, centerLat, renderZoom)
		const origin: GridOrigin = { x: center.x - subpixelW / 2, y: center.y - subpixelH / 2 }

		const zoomTileCount = 2 ** renderZoom
		const minTileX = clamp(Math.floor(origin.x / TILE_SIZE), 0, zoomTileCount - 1)
		const maxTileX = clamp(Math.floor((origin.x + subpixelW) / TILE_SIZE), 0, zoomTileCount - 1)
		const minTileY = clamp(Math.floor(origin.y / TILE_SIZE), 0, zoomTileCount - 1)
		const maxTileY = clamp(Math.floor((origin.y + subpixelH) / TILE_SIZE), 0, zoomTileCount - 1)

		const tileCoords: Array<{ x: number; y: number }> = []

		for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
			for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
				tileCoords.push({ x: tileX, y: tileY })
			}
		}

		const tiles = await Promise.all(tileCoords.map((coord) => this.source.getTile(renderZoom, coord.x, coord.y)))

		const grid = new RGBAGrid(subpixelW, subpixelH)
		const pendingLabels: PendingLabel[] = []

		for (const kind of ["fill", "line", "label"] as const) {
			for (let i = 0; i < tileCoords.length; i++) {
				const tile = tiles[i]

				if (!tile) continue

				const { x: tileX, y: tileY } = tileCoords[i]!

				rasterizeTileForKind(grid, tile, tileX, tileY, kind, renderZoom, origin, pendingLabels)
			}
		}

		if (overlays?.ring) {
			const { lon, lat, radiusMeters } = overlays.ring
			const radiusPx = radiusMeters / metersPerPixel(lat, renderZoom)

			if (radiusPx >= MIN_RING_RADIUS_PX) {
				const ringCenterWorld = lonLatToWorldPx(lon, lat, renderZoom)
				const ringColor: RGB = [255, 255, 255]

				drawCircle(grid, ringCenterWorld.x - origin.x, ringCenterWorld.y - origin.y, radiusPx, ringColor)
			}
		}

		const frame = rasterizeToFrame(grid, columns, rows, this.source.attribution)

		const occupied = new Uint8Array(columns * rows)

		for (const label of pendingLabels) {
			overlayText(frame, label.column, label.row, label.text, label.color, occupied)
		}

		if (overlays?.markers) {
			for (const marker of overlays.markers) {
				const markerWorld = lonLatToWorldPx(marker.lon, marker.lat, renderZoom)
				const px = markerWorld.x - origin.x
				const py = markerWorld.y - origin.y
				const column = Math.floor(px / SUBPIXEL_COLUMNS_PER_CELL)
				const row = Math.floor(py / SUBPIXEL_ROWS_PER_CELL)

				overlayText(
					frame,
					column,
					row,
					marker.char ?? DEFAULT_MARKER_CHAR,
					rgbToPacked(marker.color ?? DEFAULT_MARKER_COLOR)
				)
			}
		}

		return frame
	}
}
