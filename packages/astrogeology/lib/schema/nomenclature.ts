/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One nomenclature feature as represented in every artifact: east-positive longitude in −180..180, latitude in −90..90,
 *   the stable id from the source's feature link. The schema is the interface between the build and the app. a value
 *   outside it never leaves the build.
 */

import { z } from "zod"

/**
 * Read the shapefile's `""`, or a missing key, as null.
 */
const blankAsNull = <T extends z.ZodType>(inner: T) =>
	z.preprocess((value) => (value === "" || value === undefined ? null : value), inner)

/**
 * The feature record in every artifact.
 *
 * The nullable strings take the shapefile's `""` as null.
 * The coordinates are the normalized ones (east-positive, −180..180), never the source's 0..360.
 */
export const PlanetaryNomenclatureFeatureSchema = z.object({
	id: z.string().min(1),
	body: z.enum(["moon", "mars"]),
	name: z.string().min(1),
	// The shapefile writes "" for an absent string; `blankAsNull` turns it into null.
	cleanName: blankAsNull(z.string().nullable()),
	featureType: z.string().min(1),
	featureTypeCode: blankAsNull(z.string().nullable()),
	diameterKm: z.number().nonnegative().nullable().default(null),
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
		.nullable()
		.default(null),
	approvalStatus: blankAsNull(z.string().nullable()),
	approvalDate: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/u)
		.nullable()
		.default(null),
	origin: blankAsNull(z.string().nullable()),
	quadName: blankAsNull(z.string().nullable()),
	source: z.literal("usgs-iau"),
})

export type PlanetaryNomenclatureFeature = z.infer<typeof PlanetaryNomenclatureFeatureSchema>
