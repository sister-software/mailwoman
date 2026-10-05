/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one variable the application's build reads. The Vite config reads it under Node and compiles it into the
 *   client, so the browser never reads an environment.
 */

import { $public as corePublic, liveEnv } from "@mailwoman/core/env"
import { z } from "zod"

/**
 * The build variable that selects the map style.
 */
export const PublicOpportunityEnvSchema = z.object({
	OPPORTUNITY_BASEMAP_URL: z
		.url()
		.optional()
		.meta({
			title: "Opportunity map basemap TileJSON URL",
			description:
				"A TileJSON URL for the Mailwoman basemap. With it, the map draws the cartographer base style over that " +
				"tileset. Without it, the map draws a stub style with zero sources and requests no tile, glyph or sprite.",
		}),
})

/**
 * The live build environment over core's public view.
 */
export const $public = liveEnv(PublicOpportunityEnvSchema, corePublic)
