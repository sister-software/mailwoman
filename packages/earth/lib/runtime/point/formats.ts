/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One point in every encoding the map offers to copy: the decimal pair, degrees-minutes-seconds, the plus
 *   code Google prints, the H3 cell at a resolution that follows the zoom, the geohash and the MGRS reference.
 *   The encoders are `@mailwoman/spatial`'s. The H3 encoder is imported on the first call, because its
 *   WebAssembly binary has no place in the entry chunk.
 */

import type { MapContextMenuRowProps } from "@mailwoman/react/map"
import { encodePlusCode } from "@mailwoman/spatial/open-location-code"
import { coordinatePairText } from "@mailwoman/spatial/point-query"

/**
 * The finest resolution H3 defines.
 *
 * `@mailwoman/spatial/h3/cell` exports the same value beside a static import of the H3
 * library, and importing it there would put the H3 binary in the entry chunk.
 */
// repo-health-ignore private-name-shadows-export -- the spatial module that exports it imports the H3 binary statically
const H3_MAX_RESOLUTION = 15

/**
 * The H3 resolution for a map zoom: a cell a few hundred pixels across at that zoom.
 *
 * An H3 resolution step is about a 2.6-fold change in edge length and a map zoom step is a two-fold
 * change, so one resolution per zoom level keeps the cell a readable size, four levels behind the zoom.
 */
export function h3ResolutionForZoom(zoom: number): number {
	return Math.min(H3_MAX_RESOLUTION, Math.max(0, Math.round(zoom) - 4))
}

/**
 * The point's encodings, in the order the menu lists them, each as a menu row of a label and a value.
 *
 * MGRS is left out beyond latitudes 84° north and 80° south, where the grid is undefined.
 */
export async function describePoint(lat: number, lon: number, zoom: number): Promise<MapContextMenuRowProps[]> {
	const [{ toDMS, toGeohash, toMGRS }, { latLngToCell }] = await Promise.all([
		import("@mailwoman/spatial/coordinate/formats"),
		import("@sister.software/h3"),
	])

	const dms = toDMS(lat, lon)
	const mgrs = toMGRS(lat, lon)
	const resolution = h3ResolutionForZoom(zoom)

	const formats: MapContextMenuRowProps[] = [
		{
			label: "Coordinates",
			value: coordinatePairText(lat, lon),
			hint: "Decimal degrees, latitude first",
		},
		{ label: "DMS", value: `${dms.lat} ${dms.lon}`, hint: "Degrees, minutes and seconds" },
		{ label: "Plus code", value: encodePlusCode(lat, lon, 11), hint: "Open Location Code, 11 digits" },
		{ label: "H3", value: latLngToCell(lat, lon, resolution), hint: `H3 cell at resolution ${resolution}` },
		{ label: "Geohash", value: toGeohash(lat, lon), hint: "Geohash, 9 characters" },
	]

	if (mgrs) {
		formats.push({ label: "MGRS", value: mgrs, hint: "Military Grid Reference System" })
	}

	return formats
}
