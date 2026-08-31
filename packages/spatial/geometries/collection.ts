/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   GeoJSON Geometry Collection
 */

import type { LineStringLiteral, MultiLineStringLiteral } from "#geometries/line-string"
import type { MultiPointLiteral, PointLiteral } from "#geometries/point"
import type { MultiPolygonLiteral, PolygonLiteral } from "#geometries/polygon"
import type { GeoObjectLiteral } from "#objects"

/**
 * Union of the GeoJSON geometry types.
 */
export type GeometryLiteral =
	| PointLiteral
	| MultiPointLiteral
	| LineStringLiteral
	| MultiLineStringLiteral
	| PolygonLiteral
	| MultiPolygonLiteral

/**
 * A GeoJSON Geometry Collection.
 */
export interface GeometryCollection extends GeoObjectLiteral {
	/**
	 * Declares the type of GeoJSON object as a `GeometryCollection`.
	 */
	type: "GeometryCollection"
	/**
	 * An array of geometry objects.
	 */
	geometries: GeometryLiteral[]
}
