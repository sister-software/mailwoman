/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The credentials the landmark model tools send to model hosts.
 */

import { $private as corePrivate, liveEnv } from "@mailwoman/core/env"
import { z } from "zod"

/**
 * Credentials for downloading landmark models.
 *
 * Never log their values.
 */
export const PrivateStructuresEnvSchema = z.object({
	SKETCHFAB_API_KEY: z.string().optional().meta({
		title: "Sketchfab API key",
		description:
			"API key sent as `Authorization: Token <key>` to Sketchfab's download endpoint, which refuses anonymous requests.",
	}),
})

/**
 * Live structures credentials over core's.
 *
 * Never log their values.
 */
export const $private = liveEnv(PrivateStructuresEnvSchema, corePrivate)
