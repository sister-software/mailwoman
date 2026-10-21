/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker's bindings, validated on every request and refused when a var still has a placeholder value. Vars are
 *   strings in Wrangler. the two booleans are parsed here so no route compares a string to "true".
 */

import type { D1Database, RateLimit, SendEmail } from "@cloudflare/workers-types"
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
	 * Cloudflare's `send_email` binding.
	 *
	 * Present, the worker sends through it and needs no email key.
	 */
	EMAIL_SENDER?: SendEmail
	LICENSE_SIGNING_KID: string
	ISSUANCE_ENABLED: string
	SITE_ORIGIN: string
	EMAIL_FROM: string
	STRIPE_LIVE_MODE: string
	CLAIM_LIMITER: RateLimit
	REFRESH_LIMITER: RateLimit
	STATUS_LIMITER: RateLimit
	DECLARE_LIMITER: RateLimit
	EVALUATE_LIMITER: RateLimit
	DOWNLOAD_LIMITER: RateLimit
	/**
	 * The S3 API credentials, account and private bucket that presign paid-artifact downloads.
	 *
	 * All four are absent until the operator provisions the bucket, and the download
	 * route answers 503 while any is missing.
	 * Every other route runs without them.
	 */
	R2_ACCESS_KEY_ID?: string
	R2_SECRET_ACCESS_KEY?: string
	R2_ACCOUNT_ID?: string
	PAID_ARTIFACTS_BUCKET?: string
}

const notPlaceholder = z
	.string()
	.min(1)
	.refine((value) => !value.startsWith("REPLACE"), "placeholder value")

const VarsSchema = z.object({
	LICENSE_SIGNING_KID: notPlaceholder,
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
 * Validate the vars and derive the two booleans.
 *
 * @throws on a placeholder.
 * The Worker's `fetch` turns that error into a 503: a deploy with an unfilled var must refuse, never mint.
 */
export function readEnv(bindings: LicenseWorkerBindings): LicenseWorkerEnv {
	const vars = VarsSchema.parse(bindings)

	return {
		...bindings,
		issuanceEnabled: vars.ISSUANCE_ENABLED === "true",
		liveMode: vars.STRIPE_LIVE_MODE === "true",
	}
}
