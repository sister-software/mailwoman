/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The FCC Broadband Map credentials the BDC client sends.
 */

import { $private as corePrivate, liveEnv } from "@mailwoman/core/env"
import { z } from "zod"

/**
 * FCC Broadband Map (BDC) public-API credentials (`bdc/lib/sdk/client.ts`) — username + hash_value header auth. Never
 * log their values.
 */
export const PrivateBDCEnvSchema = z.object({
	FCC_MAP_USERNAME: z.string().optional().meta({
		title: "FCC Broadband Map username",
		description: "Username used to authenticate to the FCC Broadband Data Collection API.",
	}),
	FCC_MAP_API_KEY: z.string().optional().meta({
		title: "FCC Broadband Map API key",
		description: "API key hash used to authenticate to the FCC Broadband Data Collection API.",
	}),
})

/**
 * Live BDC credentials over core's. Never log their values.
 */
export const $private = liveEnv(PrivateBDCEnvSchema, corePrivate)
