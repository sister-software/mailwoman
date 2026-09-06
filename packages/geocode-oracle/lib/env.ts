/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The reference-geocoder credential the oracle's Google client sends.
 */

import { $private as corePrivate, liveEnv } from "@mailwoman/core/env"
import { z } from "zod"

/**
 * Google Maps Platform key for the reference-geocoder ORACLE (`geocode-oracle/lib/sdk/google-client.ts`). Verification
 * tooling only — nothing on the parse path reads this, and `@mailwoman/geocode-oracle` is a private workspace precisely
 * so it cannot become a runtime dependency of a published package. BILLED PER REQUEST: the client caches for 30 days
 * and paces at 60/minute by default for that reason. Never log its value.
 */
export const PrivateOracleEnvSchema = z.object({
	GOOGLE_MAPS_API_KEY: z.string().optional().meta({
		title: "Google Maps API key",
		description: "Google Maps Platform key used only by private reference-geocoder verification tooling.",
	}),
})

/**
 * Live oracle credentials over core's. Never log their values.
 */
export const $private = liveEnv(PrivateOracleEnvSchema, corePrivate)
