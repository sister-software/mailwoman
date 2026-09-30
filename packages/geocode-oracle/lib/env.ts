/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { $private as corePrivate, liveEnv } from "@mailwoman/core/env"
import { z } from "zod"

/**
 * Google Maps Platform key for the reference-geocoder oracle (`geocode-oracle/lib/sdk/google-client.ts`).
 *
 * The client is billed per request.
 * It caches for 30 days and paces at 60/minute by default.
 *
 * Never log its value.
 */
export const PrivateOracleEnvSchema = z.object({
	GOOGLE_MAPS_API_KEY: z.string().optional().meta({
		title: "Google Maps API key",
		description: "Google Maps Platform key used only by private reference-geocoder verification tooling.",
	}),
})

/**
 * Live oracle credentials layered over core's.
 *
 * Never log their values.
 */
export const $private = liveEnv(PrivateOracleEnvSchema, corePrivate)
