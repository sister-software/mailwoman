/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The closed plan catalog: code, not Stripe metadata and not client input. A Price outside it mints nothing. The two
 *   Price IDs are environment vars because sandbox and production hold different Stripe objects for the same two plans.
 */

import type { LicenseWorkerEnv } from "#env"

/**
 * Days past the paid period's end a token stays valid, the same on every plan.
 */
export const GRACE_DAYS = 14

export interface CommercialPlan {
	code: "commercial-monthly-v1" | "commercial-yearly-v1"
	stripePriceID: string
	scope: "all"
	terms: "LicenseRef-Commercial"
	/**
	 * Days past the paid period's end the token stays valid, so a renewal that lands late does not lapse a working
	 * install.
	 */
	graceDays: typeof GRACE_DAYS
}

export function planCatalog(env: LicenseWorkerEnv): readonly CommercialPlan[] {
	return [
		{
			code: "commercial-monthly-v1",
			stripePriceID: env.STRIPE_PRICE_MONTHLY,
			scope: "all",
			terms: "LicenseRef-Commercial",
			graceDays: GRACE_DAYS,
		},
		{
			code: "commercial-yearly-v1",
			stripePriceID: env.STRIPE_PRICE_YEARLY,
			scope: "all",
			terms: "LicenseRef-Commercial",
			graceDays: GRACE_DAYS,
		},
	]
}

export function planForPrice(env: LicenseWorkerEnv, priceID: string): CommercialPlan | undefined {
	return planCatalog(env).find((plan) => plan.stripePriceID === priceID)
}
