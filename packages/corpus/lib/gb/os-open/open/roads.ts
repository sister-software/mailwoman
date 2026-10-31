/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads road links with names from an OS Open Roads GML tile.
 *
 *   The GML product is one file per 100 km National Grid square. A tile holds `road:RoadLink`,
 *   `road:RoadNode` and `road:MotorwayJunction` features. Only the links hold a centreline and a
 *   name. A link with a name has a `road:name1` and a `road:roadNameTOID`. Its `xlink:href` is `#`
 *   followed by the roadNameTOID that OS Open Names uses as its `ID`. A link with only a road number
 *   includes `road:roadNumberTOID`; a link without a name or road number has neither field.
 *
 *   The centreline is a `gml:LineString` in EPSG:27700, written as a `gml:posList` of easting and
 *   northing pairs. The reader honors the line's `srsDimension` so a 3D tile would still read its
 *   first two ordinates.
 */

import { openReadStream } from "@mailwoman/core/fs/streams"
import { elementAtPath, streamMarkupElements, textAtPath, type MarkupElement } from "@mailwoman/core/html/elements"
import type { PathBuilderLike } from "path-ts"

/**
 * The feature element that contains a centreline.
 */
export const OPEN_ROADS_LINK_ELEMENT = "road:RoadLink"

/**
 * One road link with a name.
 */
export interface OpenRoadsLink {
	/**
	 * The link's `gml:id`.
	 */
	id: string
	/**
	 * `road:name1` as the tile spells it.
	 */
	name1: string
	/**
	 * The roadNameTOID, without the `#` of the reference, such as `osgb4000000010927776`.
	 */
	roadNameTOID: string
	/**
	 * The centreline as flat `[easting0, northing0, easting1, northing1, …]` in EPSG:27700 meters.
	 */
	vertices: Float64Array
}

/**
 * Counts from a read.
 */
export interface OpenRoadsReadStats {
	/**
	 * Road links read.
	 */
	links: number
	/**
	 * Road links with names that the reader yielded.
	 */
	named: number
	/**
	 * Links with no `road:name1` or no `road:roadNameTOID`.
	 */
	unnamed: number
	/**
	 * Road links whose centreline has fewer than two vertices or a non-numeric ordinate.
	 */
	malformedGeometry: number
}

/**
 * A stats object with every count at zero.
 */
export function createOpenRoadsReadStats(): OpenRoadsReadStats {
	return { links: 0, named: 0, unnamed: 0, malformedGeometry: 0 }
}

const LINE_PATH = ["net:centrelineGeometry", "gml:LineString"] as const

/**
 * Reads a link described by a `road:RoadLink` element or returns the reason it could not read one.
 */
export function readOpenRoadsLink(element: MarkupElement): OpenRoadsLink | "unnamed" | "malformed-geometry" {
	const name1 = (textAtPath(element, "road:name1") ?? "").trim()
	const href = elementAtPath(element, "road:roadNameTOID")?.attributes["xlink:href"] ?? ""
	const roadNameTOID = href.replace(/^#/u, "").trim()

	if (!name1 || !roadNameTOID) return "unnamed"

	const dimension = Number(elementAtPath(element, ...LINE_PATH)?.attributes.srsDimension ?? "2") || 2
	const posList = (textAtPath(element, ...LINE_PATH, "gml:posList") ?? "").trim()
	const ordinates = posList ? posList.split(/\s+/u) : []
	const vertexCount = Math.floor(ordinates.length / dimension)

	if (vertexCount < 2 || ordinates.length % dimension !== 0) return "malformed-geometry"

	const vertices = new Float64Array(vertexCount * 2)

	for (let vertex = 0; vertex < vertexCount; vertex++) {
		const easting = Number(ordinates[vertex * dimension])
		const northing = Number(ordinates[vertex * dimension + 1])

		if (!Number.isFinite(easting) || !Number.isFinite(northing)) return "malformed-geometry"

		vertices[vertex * 2] = easting
		vertices[vertex * 2 + 1] = northing
	}

	return { id: element.attributes["gml:id"] ?? "", name1, roadNameTOID, vertices }
}

/**
 * Streams links with names from one Open Roads GML tile.
 */
export async function* readOpenRoadsLinks(
	gmlPath: PathBuilderLike,
	stats: OpenRoadsReadStats,
	options: { signal?: AbortSignal } = {}
): AsyncGenerator<OpenRoadsLink> {
	for await (const element of streamMarkupElements(openReadStream(gmlPath), OPEN_ROADS_LINK_ELEMENT, {
		xml: true,
		signal: options.signal,
	})) {
		stats.links++

		const link = readOpenRoadsLink(element)

		if (link === "unnamed") {
			stats.unnamed++

			continue
		}

		if (link === "malformed-geometry") {
			stats.malformedGeometry++

			continue
		}

		stats.named++

		yield link
	}
}
