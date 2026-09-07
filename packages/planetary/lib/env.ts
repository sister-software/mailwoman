/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one variable the planetary build reads. It is read under Node by the Vite config and compiled into the
 *   client; the browser never sees an environment.
 */

import { $public as corePublic, liveEnv } from "@mailwoman/core/env"
import { z } from "zod"

import { PLANETARY_BODIES } from "#body"

/**
 * The build variable a Workers Builds project sets per body.
 */
export const PublicPlanetaryEnvSchema = z.object({
	PLANETARY_BODY: z.enum(PLANETARY_BODIES).meta({
		title: "Planetary body",
		description:
			"Which body this build of the planetary app is for. Read once, at build; the client is compiled for it.",
	}),
})

/**
 * The live build environment over core's public view. A missing or unknown `PLANETARY_BODY` fails the build with the
 * schema's message.
 */
export const $public = liveEnv(PublicPlanetaryEnvSchema, corePublic)
