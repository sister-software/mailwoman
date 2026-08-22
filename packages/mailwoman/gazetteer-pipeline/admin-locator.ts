/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Which admin place CONTAINS this point — a build-time point-in-polygon locator over a WOF polygon shard.
 *
 *   Built for the question a gazetteer join answers badly. Asking WOF which region a US postcode's `parent_id` leads to
 *   contradicts the ZIP numbering plan on 8.46% of placed codes; asking which region POLYGON contains the code's own
 *   coordinate contradicts it on 0.69%, a 12× improvement, using only data already shipped under permissive licences.
 *   The residual is inherited rather than produced: 264 of those 286 sit on a coordinate that is not a location.
 *
 *   A uniform grid over polygon bounding boxes keeps a lookup to a few ring tests. The naive cross product — every
 *   point against every polygon — does not finish at gazetteer scale, and the grid is the whole reason this is a
 *   sub-second pass rather than an overnight one.
 */

import { DatabaseSync } from "node:sqlite"

import { tryParsingJSON } from "@mailwoman/core/objects"
import { pointInMultiPolygon, pointInPolygon } from "@mailwoman/spatial"

type Ring = Array<[number, number]>

/**
 * One admin place the locator can return.
 */
export interface LocatedAdmin {
	id: number
	name: string
	placetype: string
}

interface Shape extends LocatedAdmin {
	minLon: number
	minLat: number
	maxLon: number
	maxLat: number
	polygons: Ring[][]
}

/**
 * Grid cell size in degrees. 0.25° is small enough that a US state's bbox spans a few hundred cells and a dense metro
 * cell holds a handful of candidates — the tradeoff is index build time against candidates per probe, and both stay
 * negligible at admin scale.
 */
const CELL_DEGREES = 0.25

export interface AdminLocatorOptions {
	/**
	 * WOF admin DB — supplies the id/name/placetype of each candidate place.
	 */
	adminPath: string
	/**
	 * WOF polygon DB — supplies the geometry. A place present in the admin DB with no row here cannot be located, and the
	 * locator counts that rather than treating it as a miss at probe time.
	 */
	polygonPath: string
	placetype: string
	/**
	 * ISO country code as the admin DB spells it (upper-case).
	 */
	country: string
}

/**
 * A loaded set of admin polygons, probed by point.
 */
export class AdminLocator {
	readonly #grid = new Map<string, Shape[]>()
	/**
	 * Places whose geometry loaded.
	 */
	readonly located: number
	/**
	 * Places present in the admin DB whose geometry the polygon DB does not carry. A caller reporting coverage needs
	 * this: a probe that finds nothing may mean the point is outside every polygon OR that the containing place has no
	 * polygon at all, and only this number separates them.
	 */
	readonly withoutGeometry: number

	constructor(options: AdminLocatorOptions) {
		const admin = new DatabaseSync(options.adminPath, { readOnly: true })
		const polys = new DatabaseSync(options.polygonPath, { readOnly: true })

		try {
			const geomStmt = polys.prepare(`select geom from polygons where id = ?`)

			const rows = admin
				.prepare(`select id, name from spr where placetype = ? and country = ? and is_current != 0`)
				.all(options.placetype, options.country) as Array<{ id: number; name: string }>

			let located = 0
			let missing = 0

			for (const row of rows) {
				const geomRow = geomStmt.get(row.id) as { geom: string } | undefined
				const geometry = geomRow ? tryParsingJSON<{ type: string; coordinates: unknown }>(geomRow.geom) : undefined

				const polygons: Ring[][] =
					geometry?.type === "MultiPolygon"
						? (geometry.coordinates as Ring[][])
						: geometry?.type === "Polygon"
							? [geometry.coordinates as Ring[]]
							: []

				if (!polygons.length) {
					missing++

					continue
				}

				located++

				let minLon = Number.POSITIVE_INFINITY
				let minLat = Number.POSITIVE_INFINITY
				let maxLon = Number.NEGATIVE_INFINITY
				let maxLat = Number.NEGATIVE_INFINITY

				for (const polygon of polygons) {
					// The OUTER ring bounds the polygon; holes are inside it by definition.
					for (const [lon, lat] of polygon[0] ?? []) {
						minLon = Math.min(minLon, lon!)
						maxLon = Math.max(maxLon, lon!)
						minLat = Math.min(minLat, lat!)
						maxLat = Math.max(maxLat, lat!)
					}
				}

				const shape: Shape = {
					id: row.id,
					name: row.name,
					placetype: options.placetype,
					minLon,
					minLat,
					maxLon,
					maxLat,
					polygons,
				}

				for (let x = Math.floor(minLon / CELL_DEGREES); x <= Math.floor(maxLon / CELL_DEGREES); x++) {
					for (let y = Math.floor(minLat / CELL_DEGREES); y <= Math.floor(maxLat / CELL_DEGREES); y++) {
						const key = `${x}:${y}`
						const bucket = this.#grid.get(key)

						if (bucket) {
							bucket.push(shape)
						} else {
							this.#grid.set(key, [shape])
						}
					}
				}
			}

			this.located = located
			this.withoutGeometry = missing
		} finally {
			polys.close()
			admin.close()
		}
	}

	/**
	 * The place containing this point, or `null` when no loaded polygon does. Ties go to the first shape loaded —
	 * overlapping admin polygons of one placetype are a source defect, not something to arbitrate here.
	 */
	locate(lon: number, lat: number): LocatedAdmin | null {
		const candidates = this.#grid.get(`${Math.floor(lon / CELL_DEGREES)}:${Math.floor(lat / CELL_DEGREES)}`)

		if (!candidates) return null

		for (const shape of candidates) {
			if (lon < shape.minLon || lon > shape.maxLon || lat < shape.minLat || lat > shape.maxLat) continue

			const hit =
				shape.polygons.length === 1
					? pointInPolygon(lon, lat, shape.polygons[0]!)
					: pointInMultiPolygon(lon, lat, shape.polygons)

			if (hit) return { id: shape.id, name: shape.name, placetype: shape.placetype }
		}

		return null
	}
}
