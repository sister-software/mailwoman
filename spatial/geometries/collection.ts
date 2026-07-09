/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   GeoJSON Geometry Collection
 */

import type { GeoObjectLiteral } from "../objects.ts"
import type { LineStringLiteral, MultiLineStringLiteral } from "./line-string.ts"
import type { MultiPointLiteral, PointLiteral } from "./point.ts"
import type { MultiPolygonLiteral, PolygonLiteral } from "./polygon.ts"

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
