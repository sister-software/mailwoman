/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker's bindings, validated on every request and refused when a var still carries a placeholder. Vars are
 *   strings in Wrangler; the two booleans are parsed here so no route compares a string to "true".
 */

import { z } from "zod"

export interface LicenseWorkerBindings {
	LICENSE_LEDGER: D1Database
	STRIPE_SECRET_KEY: string
	STRIPE_WEBHOOK_SECRET: string
	LICENSE_SIGNING_KEY_PEM: string
	/**
	 * The transactional email provider's key, read only when `EMAIL_SENDER` is absent.
	 */
	EMAIL_API_KEY?: string
	/**
	 * Cloudflare's `send_email` binding; present, the worker sends through it and needs no email key.
	 */
	EMAIL_SENDER?: SendEmail
	LICENSE_SIGNING_KID: string
	STRIPE_PRICE_MONTHLY: string
	STRIPE_PRICE_YEARLY: string
	AGREEMENT_VERSION: string
	ISSUANCE_ENABLED: string
	SITE_ORIGIN: string
	EMAIL_FROM: string
	STRIPE_LIVE_MODE: string
	CLAIM_LIMITER: RateLimit
	REFRESH_LIMITER: RateLimit
	STATUS_LIMITER: RateLimit
}

const notPlaceholder = z
	.string()
	.min(1)
	.refine((value) => !value.startsWith("REPLACE"), "placeholder value")

const VarsSchema = z.object({
	LICENSE_SIGNING_KID: notPlaceholder,
	STRIPE_PRICE_MONTHLY: notPlaceholder,
	STRIPE_PRICE_YEARLY: notPlaceholder,
	AGREEMENT_VERSION: notPlaceholder,
	ISSUANCE_ENABLED: z.enum(["true", "false"]),
	SITE_ORIGIN: z.url(),
	EMAIL_FROM: z.email(),
	STRIPE_LIVE_MODE: z.enum(["true", "false"]),
})

export interface LicenseWorkerEnv extends LicenseWorkerBindings {
	readonly issuanceEnabled: boolean
	readonly liveMode: boolean
}

/**
 * Validate the vars and derive the two booleans. Throws on a placeholder, which the Worker's `fetch` turns into a 503:
 * a deploy with an unfilled var must refuse, never mint.
 */
export function readEnv(bindings: LicenseWorkerBindings): LicenseWorkerEnv {
	const vars = VarsSchema.parse(bindings)

	return {
		...bindings,
		issuanceEnabled: vars.ISSUANCE_ENABLED === "true",
		liveMode: vars.STRIPE_LIVE_MODE === "true",
	}
}
