/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The closed plan catalog. A Price outside it mints no license. `shop/ids.json` provides Price IDs by environment Stripe mode because sandbox and production use different Stripe objects for the same two plans.
 */

import type { LicenseWorkerEnv } from "#env"
import { SHOP_IDS } from "#shop/ids"

/**
 * Days past the paid period's end a token stays valid.
 */
export const GRACE_DAYS = 14

export interface CommercialPlan {
	code: "commercial-monthly-v1" | "commercial-yearly-v1"
	stripePriceID: string
	scope: "all"
	terms: "LicenseRef-Commercial"
	graceDays: typeof GRACE_DAYS
}

export function planCatalog(env: LicenseWorkerEnv): readonly CommercialPlan[] {
	const { prices } = SHOP_IDS[env.liveMode ? "live" : "test"]

	return [
		{
			code: "commercial-monthly-v1",
			stripePriceID: prices["commercial-monthly-v1"],
			scope: "all",
			terms: "LicenseRef-Commercial",
			graceDays: GRACE_DAYS,
		},
		{
			code: "commercial-yearly-v1",
			stripePriceID: prices["commercial-yearly-v1"],
			scope: "all",
			terms: "LicenseRef-Commercial",
			graceDays: GRACE_DAYS,
		},
	]
}

export function planForPrice(env: LicenseWorkerEnv, priceID: string): CommercialPlan | undefined {
	return planCatalog(env).find((plan) => plan.stripePriceID === priceID)
}
