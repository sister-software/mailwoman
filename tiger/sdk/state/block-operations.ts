/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { GeometryLiteral, MultiPolygonLiteral } from "@mailwoman/spatial"
import { wellKnownGeometryToGeoJSON } from "@mailwoman/spatial/sdk"
import {
	FIPSStateCode,
	type FIPSBlockGeoID,
	type FIPSTractCode,
	type TIGERBlockFeature,
	type TIGERBlockFeatureCollection,
	type TIGERTabulatedBlockProperties,
} from "@mailwoman/tiger"

export interface StateBlockIntersectionCriteria {
	stateCode: FIPSStateCode
	geometry: GeometryLiteral
	tractCodes?: FIPSTractCode[]
}

//#region Row parsing

/**
 * @internal
 */
export interface TIGERBlockRow extends TIGERTabulatedBlockProperties {
	GEOID: FIPSBlockGeoID
	/**
	 * @format hex
	 */
	serializedGeometry: string
}

/**
 * Given a row from the TIGER tabulated block table, parses it into a GeoJSON feature.
 *
 * @internal
 */
export function parseTIGERBlockFromRow({ serializedGeometry, ...properties }: TIGERBlockRow): TIGERBlockFeature {
	const feature: TIGERBlockFeature = {
		type: "Feature",
		id: properties.GEOID,
		geometry: wellKnownGeometryToGeoJSON<MultiPolygonLiteral>(Buffer.from(serializedGeometry, "hex")),
		properties,
	}

	return feature
}

/**
 * Given a collection of rows from the TIGER tabulated block table, parses them into a GeoJSON
 * feature collection.
 *
 * @internal
 */
export function parseTIGERBlockFeatureCollectionFromRows(rows: TIGERBlockRow[]): TIGERBlockFeatureCollection {
	const features = rows.map(parseTIGERBlockFromRow)
	const featureCollection: TIGERBlockFeatureCollection = {
		type: "FeatureCollection",
		features,
	}

	return featureCollection
}

//#endregion
