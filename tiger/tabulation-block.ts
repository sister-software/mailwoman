/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type MultiPolygonLiteral } from "@mailwoman/spatial"

import { TIGERProperty, type TIGERPropertyRecord } from "./constants.ts"
import { GeoIDPart, type FIPSBlockGeoID, type ParsedGeoIDBlockLevel } from "./geoid.ts"

/**
 * The properties of a tabulated block from the TIGER/Line dataset.
 */
export type TIGERTabulatedBlockProperties = Pick<
	TIGERPropertyRecord<FIPSBlockGeoID>,
	| typeof TIGERProperty.GeoID
	| typeof GeoIDPart.CountySubDivision
	| typeof GeoIDPart.Tract
	| typeof GeoIDPart.Place
	| typeof GeoIDPart.BlockGroup
	| typeof GeoIDPart.Block
	| typeof GeoIDPart.Place
	| typeof GeoIDPart.CongressionalDistrict
	| typeof TIGERProperty.ClassCode
	| typeof TIGERProperty.UrbanRuralCode
	| typeof TIGERProperty.UrbanizedAreaCode
	| typeof TIGERProperty.FunctionalStatus
	| typeof TIGERProperty.LandAreaSqm
	| typeof TIGERProperty.WaterAreaSqm
	| typeof TIGERProperty.CentroidLatitude
	| typeof TIGERProperty.CentroidLongitude
	| typeof TIGERProperty.HousingUnitCount
	| typeof TIGERProperty.Population
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
	 * The geometry of the tabulated block, typically a polygon, but may be a multi-polygon for blocks with holes, or
	 * islands.
	 *
	 * @title Geometry
	 */
	GEOMETRY: MultiPolygonLiteral
}
