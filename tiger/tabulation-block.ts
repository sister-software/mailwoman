/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type MultiPolygonLiteral } from "@mailwoman/spatial"
import { TIGERProperty, type TIGERPropertyRecord } from "./constants.js"
import { GeoIDPart, type FIPSBlockGeoID, type ParsedGeoIDBlockLevel } from "./geoid.js"

/**
 * The properties of a tabulated block from the TIGER/Line dataset.
 */
export type TIGERTabulatedBlockProperties = Pick<
	TIGERPropertyRecord<FIPSBlockGeoID>,
	| TIGERProperty.GeoID
	| GeoIDPart.CountySubDivision
	| GeoIDPart.Tract
	| GeoIDPart.Place
	| GeoIDPart.BlockGroup
	| GeoIDPart.Block
	| GeoIDPart.Place
	| GeoIDPart.CongressionalDistrict
	| TIGERProperty.ClassCode
	| TIGERProperty.UrbanRuralCode
	| TIGERProperty.UrbanizedAreaCode
	| TIGERProperty.FunctionalStatus
	| TIGERProperty.LandAreaSqm
	| TIGERProperty.WaterAreaSqm
	| TIGERProperty.CentroidLatitude
	| TIGERProperty.CentroidLongitude
	| TIGERProperty.HousingUnitCount
	| TIGERProperty.Population
>

export interface TIGERBlockFeature {
	type: "Feature"
	id: FIPSBlockGeoID
	geometry: MultiPolygonLiteral
	properties: TIGERTabulatedBlockProperties
}

export interface TIGERBlockFeatureCollection {
	type: "FeatureCollection"
	features: TIGERBlockFeature[]
}

/**
 * A tabulated block from the TIGER/Line dataset.
 *
 * @public
 */
export interface TIGERTabulatedBlock extends ParsedGeoIDBlockLevel, TIGERTabulatedBlockProperties {
	/**
	 * The GeoID of the tabulated block.
	 *
	 * @title GeoID
	 */
	GEOID: FIPSBlockGeoID

	/**
	 * The geometry of the tabulated block, typically a polygon, but may be a multi-polygon for blocks
	 * with holes, or islands.
	 *
	 * @title Geometry
	 */
	GEOMETRY: MultiPolygonLiteral
}
