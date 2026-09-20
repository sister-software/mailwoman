// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { smartSnakeCase } from "@mailwoman/core"

import { TIGERProperty } from "#index"

/**
 * Default column selections for tiger tabulated block entities.
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
