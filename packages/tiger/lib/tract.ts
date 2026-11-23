// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { GeoFeature, MultiPolygonLiteral } from "@mailwoman/spatial"

import type { TIGERProperty, TIGERPropertyRecord } from "#constants"
import type { FIPSTractGeoID, GeoIDPart, ParsedGeoIDTractLevel } from "#geoid"

/**
 * @title TIGER Tract
 * @public
 */
export interface TIGERTract extends ParsedGeoIDTractLevel {
	/**
	 * The GeoID that identifies the tract.
	 *
	 * @title Geo ID
	 */
	GEOID: FIPSTractGeoID

	/**
	 * The tract's geometry is typically a polygon.
	 *
	 * It may be a multipolygon when the tract contains holes or islands.
	 *
	 * @title Geometry
	 */
	GEOMETRY: MultiPolygonLiteral
}

/**
 * Properties recorded for a Census tract.
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
 * A GeoJSON feature that represents a Census tract.
 */
export type TIGERTractFeature = GeoFeature<MultiPolygonLiteral, TIGERTractProperties>
