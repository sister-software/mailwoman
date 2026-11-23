// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The closed plan catalog.
 *
 * A Price outside the catalog mints no license.
 * `shop/ids.json` provides Price IDs by environment Stripe mode because sandbox
 * and production use different Stripe objects for the same two plans.
 */

import { GRACE_DAYS, type ShopPlanCode } from "@mailwoman/license/product/plans"

import type { LicenseWorkerEnv } from "#env"
import { SHOP_IDS } from "#shop/ids"

export interface CommercialPlan {
	code: ShopPlanCode
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

export function planForPrice(env: LicenseWorkerEnv, priceID: string): CommercialPlan | null {
	return planCatalog(env).find((plan) => plan.stripePriceID === priceID) ?? null
}
