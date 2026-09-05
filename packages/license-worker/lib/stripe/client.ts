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

/**
 * @param fetchImplementation The fetch the SDK calls; a test passes a stub that answers by method and path, so no
 *   request leaves the process and an unexpected retrieval fails loudly.
 */
/**
 * The HTTP status Stripe answers for an id it does not know.
 */
const STRIPE_NOT_FOUND = 404

/**
 * Stripe answered 404 for the id asked about: the one error a route turns into its own 404 rather than a 500.
 */
export function isStripeNotFound(error: unknown): boolean {
	return error instanceof Stripe.errors.StripeError && error.statusCode === STRIPE_NOT_FOUND
}

export function stripeClient(env: LicenseWorkerEnv, fetchImplementation: typeof fetch = fetch): Stripe {
	return new Stripe(env.STRIPE_SECRET_KEY, {
		apiVersion: STRIPE_API_VERSION,
		httpClient: Stripe.createFetchHttpClient(fetchImplementation),
		maxNetworkRetries: 0,
	})
}
