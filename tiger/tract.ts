/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type GeoFeature, type MultiPolygonLiteral } from "@mailwoman/spatial"

import { TIGERProperty, type TIGERPropertyRecord } from "./constants.ts"
import type { FIPSTractGeoID, GeoIDPart, ParsedGeoIDTractLevel } from "./geoid.ts"

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
	 * The geometry of the tabulated block, typically a polygon, but may be a multi-polygon for blocks with holes, or
	 * islands.
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
	| typeof TIGERProperty.GeoID
	| typeof GeoIDPart.State
	| typeof GeoIDPart.County
	| typeof GeoIDPart.Tract
	| typeof TIGERProperty.ClassCode
	| typeof TIGERProperty.FunctionalStatus
	| typeof TIGERProperty.LandAreaSqm
	| typeof TIGERProperty.WaterAreaSqm
	| typeof TIGERProperty.CentroidLongitude
	| typeof TIGERProperty.CentroidLatitude
>

/**
 * A geographci feature representing a Census Tract.
 */
export type TIGERTractFeature = GeoFeature<MultiPolygonLiteral, TIGERTractProperties>
