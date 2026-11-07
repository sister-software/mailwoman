/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A Who's On First id typed as a query, read from the browser's own range readers: the gazetteer's containment
 *   chain lists the place's parents, and the release's polygon file places it. Neither reader indexes a place's
 *   own name by id, so the answer is a located outline with its chain rather than the gazetteer row with its name.
 */

import type { ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import { geomBounds, type PlaceGeometry } from "@mailwoman/react/map/geometry"

import { type Ancestor, type Gazetteer, placeByID } from "../explorers/Gazette/gazetteer.ts"
import { gazettePlacePath } from "../routes.ts"
import type { PolygonDB } from "./basemap.ts"

/**
 * A located Who's On First place and the polygon that located it.
 */
export interface WOFPlace {
	place: ResolvedPlaceView
	geometry: PlaceGeometry
}

/**
 * The place behind a Who's On First id, located by its polygon, or a thrown error
 * whose message states what was and was not found.
 *
 * `polygons` is `null` on a runtime that loads no polygon file, and the error then states that reason.
 * A read either reader cannot complete throws its own error, so an unreadable
 * id never reads as an absent one.
 */
export async function readWOFPlace(gazetteer: Gazetteer, id: number, polygons: PolygonDB | null): Promise<WOFPlace> {
	const [known, geometry] = await Promise.all([placeByID(gazetteer, id), polygons?.get(id) ?? null])
	const chain = onePerPlacetype(known.ancestors)
	const where = chain.map((ancestor) => ancestor.name).join(", ")
	const reference = `wof:${id}`

	if (!geometry) {
		const sits = where
			? ` It sits in ${where}, and the gazette lists that chain at ${gazettePlacePath({ sprID: id, nameKey: null })}.`
			: ""

		if (!known.known && !known.ancestors.length) {
			throw new Error(
				`${reference} is not a place in gazetteer ${gazetteer.version}, and the release holds no polygon for it.`
			)
		}

		throw new Error(
			polygons
				? `${reference} has no polygon in the boundary file, so it has no coordinate to show.${sits}`
				: `${reference} cannot be placed here: this runtime loads no polygon file.${sits}`
		)
	}

	const [lon, lat] = largestRingCenter(geometry)
	const parent = chain[0]

	return {
		geometry,
		place: {
			id,
			name: where ? `${reference} in ${where}` : reference,
			placetype: parent ? `inside ${parent.placetype} ${parent.name}` : "place",
			lat,
			lon,
			score: 1,
			bbox: geomBounds(geometry),
			tier: null,
			uncertaintyM: null,
		},
	}
}

/**
 * The chain with one ancestor per placetype, nearest first.
 *
 * A place with several hierarchies, such as London with a row per borough, lists every parent
 * in the closure table, and the first of each placetype is enough to say where the place sits.
 */
function onePerPlacetype(ancestors: readonly Ancestor[]): Ancestor[] {
	const seen = new Set<string>()

	return ancestors.filter((ancestor) => {
		if (seen.has(ancestor.placetype)) return false

		seen.add(ancestor.placetype)

		return true
	})
}

/**
 * The center of the box around the geometry's largest outer ring, as `[lon, lat]`.
 *
 * The box around a whole multi-polygon can center on the far side of the world when its parts
 * straddle the antimeridian, as a country with Pacific islands does, so the pin reads one ring.
 */
function largestRingCenter(geometry: PlaceGeometry): [lon: number, lat: number] {
	const rings = geometry.type === "Polygon" ? [geometry.coordinates[0]!] : geometry.coordinates.map((part) => part[0]!)
	const largest = rings.toSorted((a, b) => b.length - a.length)[0]!
	const bbox = geomBounds({ type: "Polygon", coordinates: [largest] })

	return [(bbox.minLon + bbox.maxLon) / 2, (bbox.minLat + bbox.maxLat) / 2]
}
