/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Stripe SDK on the Workers runtime: the fetch HTTP client instead of Node's, and a pinned API version so a Stripe
 *   upgrade is a deliberate change here, never a drift. The SubtleCrypto provider for webhook signatures lives beside
 *   the verifier in `webhook.ts`.
 */

import Stripe from "stripe"

import type { LicenseWorkerEnv } from "#env"

/**
 * The version the installed SDK's types describe (`stripe/esm/apiVersion.js`); the two move together.
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia"

export function stripeClient(env: LicenseWorkerEnv): Stripe {
	return new Stripe(env.STRIPE_SECRET_KEY, {
		apiVersion: STRIPE_API_VERSION,
		httpClient: Stripe.createFetchHttpClient(),
		maxNetworkRetries: 2,
	})
}
