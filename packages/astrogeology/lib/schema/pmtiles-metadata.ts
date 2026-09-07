/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mailwoman:*` block every planetary archive carries in its PMTiles metadata: which body, which kind, which
 *   coordinate convention, which source and build. The app reads the block before it reads a tile, and the verify step
 *   reads it back after the build writes it.
 */

import { z } from "zod"

/**
 * The block, validated on write and on read. `mailwoman:coordinate_longitude` is fixed: every artifact is east-positive
 * in −180..180, whatever the source carried.
 */
export const PMTilesMetadataSchema = z.object({
	"mailwoman:kind": z.enum(["planetary-basemap", "planetary-hillshade", "planetary-dem"]),
	"mailwoman:body": z.enum(["moon", "mars"]),
	"mailwoman:schema": z.literal("planetary-v1"),
	"mailwoman:coordinate_longitude": z.literal("east-positive--180-180"),
	"mailwoman:coordinate_latitude": z.enum(["planetocentric", "planetographic"]),
	"mailwoman:source": z.string().min(1),
	"mailwoman:build_version": z.string().min(1),
	"mailwoman:vertical_datum": z.string().optional(),
	"mailwoman:elevation_unit": z.literal("metre").optional(),
	"mailwoman:source_product": z.string().optional(),
})

export type PMTilesMetadata = z.infer<typeof PMTilesMetadataSchema>
