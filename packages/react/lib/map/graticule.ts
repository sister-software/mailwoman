/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The graticule's geometry, apart from its component — the same split `place-render.ts` keeps from
 *   `ResolvedPlaceLayers.tsx`. Pure and node-testable; `#*` resolves `.ts` only, so this is also the file the test can
 *   import.
 */

import type { FeatureCollection, MultiLineString } from "geojson"

/**
 * Degrees between grid lines. 15° is one hour of longitude — twelve meridians and eleven parallels, dense enough to
 * read as a globe and sparse enough not to read as graph paper.
 */
const DEFAULT_STEP_DEGREES = 15

/**
 * Degrees between vertices ALONG each line. A meridian drawn as two points is a straight chord through the sphere
 * under a globe projection; it has to be densified to curve. 2° keeps the longest line under 100 vertices.
 */
const VERTEX_STEP_DEGREES = 2

/**
 * The latitude the parallels stop at. Past ~85° the meridians have converged close enough that more rings read as a
 * smudge at the pole, and Web Mercator's own limit is 85.051129.
 */
const MAX_LATITUDE = 85

/**
 * Build the graticule as one MultiLineString. Pure — same step, same geometry — so it is built once at module scope
 * and never rebuilt for a render.
 */
export function buildGraticule(stepDegrees: number = DEFAULT_STEP_DEGREES): FeatureCollection<MultiLineString> {
	const lines: number[][][] = []

	// Meridians: constant longitude, walking latitude pole to pole.
	for (let lon = -180; lon < 180; lon += stepDegrees) {
		const line: number[][] = []

		for (let lat = -MAX_LATITUDE; lat <= MAX_LATITUDE; lat += VERTEX_STEP_DEGREES) {
			line.push([lon, lat])
		}

		line.push([lon, MAX_LATITUDE])
		lines.push(line)
	}

	// Parallels: constant latitude, walking longitude all the way round. The equator is included; the poles are not.
	for (let lat = -MAX_LATITUDE + stepDegrees; lat < MAX_LATITUDE; lat += stepDegrees) {
		const line: number[][] = []

		for (let lon = -180; lon <= 180; lon += VERTEX_STEP_DEGREES) {
			line.push([lon, lat])
		}

		lines.push(line)
	}

	return {
		type: "FeatureCollection",
		features: [{ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: lines } }],
	}
}
