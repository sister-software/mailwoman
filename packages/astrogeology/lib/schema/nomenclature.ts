/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One nomenclature feature as every artifact carries it: east-positive longitude in −180..180, latitude in −90..90,
 *   the stable id from the source's feature link. The schema is the contract between the build and the app; a value
 *   outside it never leaves the build.
 */

import { blankAsAbsent } from "@mailwoman/core/env/utils"
import { z } from "zod"

/**
 * The feature record every artifact carries. The optional strings take the shapefile's `""` as absence; the coordinates
 * are the normalized ones (east-positive, −180..180), never the source's 0..360.
 */
export const PlanetaryNomenclatureFeatureSchema = z.object({
	id: z.string().min(1),
	body: z.enum(["moon", "mars"]),
	name: z.string().min(1),
	// The shapefile writes "" for an absent string; `blankAsAbsent` (the env schema helper, the one home for that
	// mapping) turns it into absence before the optional applies.
	cleanName: blankAsAbsent(z.string().optional()),
	featureType: z.string().min(1),
	featureTypeCode: blankAsAbsent(z.string().optional()),
	diameterKm: z.number().nonnegative().optional(),
	centerLon: z.number().min(-180).max(180),
	centerLat: z.number().min(-90).max(90),
	bbox: z
		.object({
			minLon: z.number().min(-180).max(180),
			maxLon: z.number().min(-180).max(180),
			minLat: z.number().min(-90).max(90),
			maxLat: z.number().min(-90).max(90),
			crossesAntimeridian: z.boolean(),
		})
		.optional(),
	approvalStatus: blankAsAbsent(z.string().optional()),
	approvalDate: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/u)
		.optional(),
	origin: blankAsAbsent(z.string().optional()),
	quadName: blankAsAbsent(z.string().optional()),
	source: z.literal("usgs-iau"),
})

export type PlanetaryNomenclatureFeature = z.infer<typeof PlanetaryNomenclatureFeatureSchema>
