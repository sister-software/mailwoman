/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { smartSnakeCase } from "@mailwoman/core"
import { TIGERProperty } from "@mailwoman/tiger"

/**
 * Default column selections for TIGER tabulated block entities.
 *
 * @internal
 */
export const TIGERTabulatedBlockEntitySelections = (
	[
		TIGERProperty.GeoID,
		TIGERProperty.UrbanizedAreaCode,
		TIGERProperty.UrbanRuralCode,
		TIGERProperty.HousingUnitCount,
		TIGERProperty.LandAreaSqm,
		TIGERProperty.WaterAreaSqm,
		TIGERProperty.Population,
	] as const
).map((columnName) => smartSnakeCase(columnName))
