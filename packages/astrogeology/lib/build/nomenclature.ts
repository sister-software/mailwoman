/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The nomenclature build reads shapefile rows from the pinned archive and converts each with `featureFromSourceRow`.
 *   It writes NDJSON with a per-feature minimum zoom, then runs `tippecanoe` once to create a PMTiles archive.
 *
 *   The row reader reads attributes rather than geometry. The shapefile CRS belongs to the body (`GCS_Moon_2000`,
 *   `GCS_Mars_2000`). proj cannot transform it to WGS84, but the GeoJSON writer requires WGS84 output. The transport
 *   therefore declares WGS84 as both source and destination so the writer copies the numbers unchanged. That label
 *   applies only to transport. The build reads `center_lon` and `center_lat`.
 *   It also reads the bounding box in the source convention.
 *   The manifest records that convention. `normalize.ts` converts the values.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import type { PathBuilderLike } from "path-ts"
import { resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { BODIES, type BuildableBodyID } from "#bodies"
import type { NomenclatureSourceRow } from "#normalize"
import type { PlanetaryNomenclatureFeature } from "#schema/nomenclature"

/**
 * The layer name inside each body's nomenclature archive.
 */
export const NOMENCLATURE_LAYERS = {
	moon: "MOON_nomenclature_center_pts",
	mars: "MARS_nomenclature_center_pts",
} as const satisfies Record<BuildableBodyID, string>

/**
 * The rows of the shapefile inside the archive, one at a time.
 */
export async function* readNomenclatureRows(
	archivePath: PathBuilderLike,
	layer: string
): AsyncIterable<NomenclatureSourceRow> {
	await using scratch = await temporaryDirectory("astrogeology-rows-")
	const seq = resolvePath(scratch.path, `${layer}.geojsonl`)

	await runFile("ogr2ogr", [
		"-f",
		"GeoJSONSeq",
		"-s_srs",
		"EPSG:4326",
		"-t_srs",
		"EPSG:4326",
		seq,
		`/vsizip/${archivePath}`,
		layer,
	])

	for await (const feature of JSONSpliterator.fromAsync<{ properties: NomenclatureSourceRow }>(seq)) {
		yield feature.properties
	}
}

/**
 * The declutter table: the smallest diameter, in kilometers, that appears at each zoom, largest first.
 *
 * A feature smaller than every row appears at {@link SMALLEST_FEATURE_ZOOM}.
 * Cartographic decluttering rather than ranking.
 */
const DECLUTTER_STEPS: ReadonlyArray<readonly [minDiameterKm: number, zoom: number]> = [
	[300, 0],
	[100, 2],
	[30, 4],
	[10, 6],
]

/**
 * The zoom at which a feature smaller than every declutter step appears.
 */
const SMALLEST_FEATURE_ZOOM = 8

/**
 * The zoom at which a feature with no diameter (a region, a landing site, an albedo feature) appears.
 */
const UNSIZED_FEATURE_ZOOM = 2

/**
 * The zoom at which a feature first appears, from its diameter in kilometers, by {@link DECLUTTER_STEPS}.
 */
export function minZoomForDiameter(diameterKm: number | null): number {
	if (diameterKm === null || diameterKm === 0) return UNSIZED_FEATURE_ZOOM

	for (const [minDiameterKm, zoom] of DECLUTTER_STEPS) {
		if (diameterKm >= minDiameterKm) return zoom
	}

	return SMALLEST_FEATURE_ZOOM
}

/**
 * The tippecanoe layer in every nomenclature archive.
 */
export const NOMENCLATURE_LAYER = "nomenclature"

/**
 * One GeoJSON point feature per nomenclature feature, with the tippecanoe hints on the line.
 */
export function nomenclatureNDJSONLine(feature: PlanetaryNomenclatureFeature): string {
	const { centerLon, centerLat, ...properties } = feature

	return stringifyJSON({
		type: "Feature",
		tippecanoe: { layer: NOMENCLATURE_LAYER, minzoom: minZoomForDiameter(feature.diameterKm ?? null) },
		geometry: { type: "Point", coordinates: [centerLon, centerLat] },
		properties: { ...properties, bbox: properties.bbox ? stringifyJSON(properties.bbox) : undefined },
	})
}

/**
 * Write the features as ndjson for tippecanoe.
 */
export async function writeNomenclatureNDJSON(
	features: Iterable<PlanetaryNomenclatureFeature>,
	outPath: string
): Promise<number> {
	const lines: string[] = []

	for (const feature of features) {
		lines.push(nomenclatureNDJSONLine(feature))
	}

	await writeLocalTextFile(lines, outPath)

	return lines.length
}

export interface NomenclatureBuildOptions {
	body: BuildableBodyID
	ndjsonPath: string
	outPath: string
}

/**
 * The tippecanoe run.
 *
 * `-r1` turns off density-based point dropping, so the per-feature `minzoom` is the only declutter.
 */
export async function buildNomenclaturePMTiles(options: NomenclatureBuildOptions): Promise<{ command: string[] }> {
	const args = [
		"-o",
		options.outPath,
		"-l",
		NOMENCLATURE_LAYER,
		"-n",
		`Mailwoman ${BODIES[options.body].name} nomenclature`,
		"-A",
		"USGS Astrogeology / IAU Working Group for Planetary System Nomenclature (public domain)",
		"--minimum-zoom",
		"0",
		"--maximum-zoom",
		"8",
		"-r1",
		"--no-feature-limit",
		"--no-tile-size-limit",
		"--no-progress-indicator",
		"--force",
		options.ndjsonPath,
	]

	await runFile("tippecanoe", args)

	return { command: ["tippecanoe", ...args] }
}
