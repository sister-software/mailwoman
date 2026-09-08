/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The nomenclature build: shapefile rows out of the pinned archive, features through `featureFromSourceRow`, NDJSON
 *   with a per-feature minimum zoom, and one `tippecanoe` run into a PMTiles archive.
 *
 *   THE ROW READER READS ATTRIBUTES, NOT GEOMETRY. The shapefile's CRS is the body's own (`GCS_Moon_2000`,
 *   `GCS_Mars_2000`), PROJ refuses to relate it to WGS84, and the GeoJSON writer insists on WGS84 output. So the
 *   transport declares the source as WGS84 on both sides, which makes the writer copy the numbers through untouched;
 *   the label is on the transport only. The values the build reads are the row's `center_lon`, `center_lat` and the
 *   bounding box, in the source's own convention, which the manifest records and `normalize.ts` converts.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { runFile } from "@mailwoman/core/process"
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
export async function* readNomenclatureRows(archivePath: string, layer: string): AsyncIterable<NomenclatureSourceRow> {
	await using scratch = await temporaryDirectory("astrogeology-rows-")
	const seq = resolvePath(scratch.path, `${layer}.geojsonl`)

	await runFile("ogr2ogr", [
		"-f",
		"GeoJSONSeq",
		"-s_srs",
		"EPSG:4326",
		"-t_srs",
		"EPSG:4326",
		String(seq),
		`/vsizip/${archivePath}`,
		layer,
	])

	for await (const feature of JSONSpliterator.fromAsync<{ properties: NomenclatureSourceRow }>(String(seq))) {
		yield feature.properties
	}
}

/**
 * The declutter table: the smallest diameter, in kilometres, that appears at each zoom, largest first. A feature
 * smaller than every row appears at {@link SMALLEST_FEATURE_ZOOM}. Cartographic decluttering, not ranking.
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
 * The zoom at which a feature first appears, from its diameter in kilometres, by {@link DECLUTTER_STEPS}.
 */
export function minZoomForDiameter(diameterKm: number | undefined): number {
	if (diameterKm === undefined || diameterKm === 0) return UNSIZED_FEATURE_ZOOM

	for (const [minDiameterKm, zoom] of DECLUTTER_STEPS) {
		if (diameterKm >= minDiameterKm) return zoom
	}

	return SMALLEST_FEATURE_ZOOM
}

/**
 * The tippecanoe layer every nomenclature archive carries.
 */
export const NOMENCLATURE_LAYER = "nomenclature"

/**
 * One GeoJSON point feature per nomenclature feature, with the tippecanoe hints on the line.
 */
export function nomenclatureNDJSONLine(feature: PlanetaryNomenclatureFeature): string {
	const { centerLon, centerLat, ...properties } = feature

	return JSON.stringify({
		type: "Feature",
		tippecanoe: { layer: NOMENCLATURE_LAYER, minzoom: minZoomForDiameter(feature.diameterKm) },
		geometry: { type: "Point", coordinates: [centerLon, centerLat] },
		properties: { ...properties, bbox: properties.bbox ? JSON.stringify(properties.bbox) : undefined },
	})
}

/**
 * Write the features as NDJSON for tippecanoe.
 */
export async function writeNomenclatureNDJSON(
	features: Iterable<PlanetaryNomenclatureFeature>,
	outPath: string
): Promise<number> {
	const lines: string[] = []

	for (const feature of features) {
		lines.push(nomenclatureNDJSONLine(feature))
	}

	await writeLocalTextFile(lines.join("\n") + "\n", outPath)

	return lines.length
}

export interface NomenclatureBuildOptions {
	body: BuildableBodyID
	ndjsonPath: string
	outPath: string
}

/**
 * The tippecanoe run. `-r1` turns off density-based point dropping, so the per-feature `minzoom` is the only declutter.
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
