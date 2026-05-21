/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type GeoFeature, type MultiPolygonLiteral } from "@mailwoman/spatial"
import { TIGERProperty, type TIGERPropertyRecord } from "./constants.js"
import type { FIPSTractGeoID, GeoIDPart, ParsedGeoIDTractLevel } from "./geoid.js"

/**
 * @title TIGER Tract
 * @public
 */
export interface TIGERTract extends ParsedGeoIDTractLevel {
	/**
	 * The GeoID of the tabulated block.
	 *
	 * @title Geo ID
	 */
	GEOID: FIPSTractGeoID

	/**
	 * The geometry of the tabulated block, typically a polygon, but may be a multi-polygon for blocks
	 * with holes, or islands.
	 *
	 * @title Geometry
	 */
	GEOMETRY: MultiPolygonLiteral
}

/**
 * Properties of a Census Tract.
 */
export type TIGERTractProperties = Pick<
	TIGERPropertyRecord<FIPSTractGeoID>,
	| TIGERProperty.GeoID
	| GeoIDPart.State
	| GeoIDPart.County
	| GeoIDPart.Tract
	| TIGERProperty.ClassCode
	| TIGERProperty.FunctionalStatus
	| TIGERProperty.LandAreaSqm
	| TIGERProperty.WaterAreaSqm
	| TIGERProperty.CentroidLongitude
	| TIGERProperty.CentroidLatitude
>

/**
 * A geographci feature representing a Census Tract.
 */
export type TIGERTractFeature = GeoFeature<MultiPolygonLiteral, TIGERTractProperties>
