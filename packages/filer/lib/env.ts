/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The identifying User-Agent strings the SEC EDGAR and FCC CORES clients send.
 */

import { $private as corePrivate, liveEnv } from "@mailwoman/core/env"
import { z } from "zod"

/**
 * Request identity for the filer crosswalk's upstream clients. Never log their values.
 */
export const PrivateFilerEnvSchema = z.object({
	SEC_EDGAR_USER_AGENT: z
		.string()
		.optional()
		.meta({
			title: "SEC EDGAR User-Agent",
			description: "Identifying User-Agent required for SEC EDGAR fair-access requests.",
			examples: ["Company Name AdminContact@domain.com"],
		}),
	/**
	 * Descriptive User-Agent for the FCC CORES lookup (`filer/lib/sdk/cores-client.ts`). Optional in a way
	 * `SEC_EDGAR_USER_AGENT` is not: SEC 403s a request that fails to identify itself, FCC does not. Falls back to
	 * `SEC_EDGAR_USER_AGENT` — the same contact address — when unset.
	 */
	FCC_CORES_USER_AGENT: z.string().optional().meta({
		title: "FCC CORES User-Agent",
		description:
			"Descriptive User-Agent used for FCC CORES requests; falls back to the SEC EDGAR User-Agent when unset.",
	}),
})

/**
 * Live filer credentials over core's. Never log their values.
 */
export const $private = liveEnv(PrivateFilerEnvSchema, corePrivate)
