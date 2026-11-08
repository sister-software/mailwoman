// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   OS Open Roads as a street network source, under the Open Government Licence v3.0.
 */

import {
	createOpenRoadsReadStats,
	readOpenRoadsNetwork,
	type OpenRoadsReadStats,
} from "@mailwoman/corpus/gb/os-open/open/roads"
import { osgb36ToWGS84 } from "@mailwoman/spatial/osgb36"
import type { PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import type { StreetNetworkEdge } from "#tools/pipeline/streets"

const toPoint = (vertices: Float64Array, vertex: number) => {
	const { latitude, longitude } = osgb36ToWGS84({ easting: vertices[vertex * 2]!, northing: vertices[vertex * 2 + 1]! })

	return { lat: latitude, lon: longitude }
}

/**
 * Streams every labeled road link under a directory of Open Roads GML tiles as a network edge.
 */
export async function* readOpenRoadsEdges(
	directory: PathBuilderLike,
	stats: OpenRoadsReadStats = createOpenRoadsReadStats()
): AsyncGenerator<StreetNetworkEdge> {
	const tiles = await Globerator.from("**/*.gml", { cwd: directory.toString(), absolute: true }).toArray()

	for (const tile of tiles.toSorted()) {
		for await (const link of readOpenRoadsNetwork(tile, stats)) {
			const vertexCount = link.vertices.length / 2

			yield {
				name: link.name,
				alternateName: link.alternateName,
				startNode: link.startNode,
				endNode: link.endNode,
				start: toPoint(link.vertices, 0),
				middle: toPoint(link.vertices, Math.floor(vertexCount / 2)),
				end: toPoint(link.vertices, vertexCount - 1),
				meters: link.meters,
			}
		}
	}
}
