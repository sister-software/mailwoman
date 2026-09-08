/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A clicked tile feature becomes a selection through the pipeline's own schema, so the app never trusts a tile
 *   property it did not validate: a tile from an older build, or a property tippecanoe coerced, fails here instead of
 *   rendering as a feature with a missing name.
 */

import { PlanetaryNomenclatureFeatureSchema } from "@mailwoman/astrogeology/schema/nomenclature"

import type { SelectedFeature } from "#features/selected"

/**
 * The fields a selection carries, as the pipeline defines them. The tile carries the center as geometry, not as a
 * property, so the caller passes the coordinates it read from the feature's geometry.
 */
const SelectedFeatureSchema = PlanetaryNomenclatureFeatureSchema.pick({
	id: true,
	name: true,
	featureType: true,
	featureTypeCode: true,
	diameterKm: true,
	origin: true,
	approvalStatus: true,
	approvalDate: true,
})

/**
 * The selection a tile feature's properties and position describe, or null when they do not describe one.
 */
export function featureFromTileProperties(
	properties: unknown,
	center: { longitude: number; latitude: number }
): SelectedFeature | null {
	const parsed = SelectedFeatureSchema.safeParse(properties)

	if (!parsed.success) return null

	return { ...parsed.data, centerLon: center.longitude, centerLat: center.latitude }
}
