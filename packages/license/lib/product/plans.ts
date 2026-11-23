// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The published platform plans: their codes, billing intervals and prices, and the grace period
 *   a purchased key runs past its paid period.
 *
 *   The license worker's provisioner sends these prices to Stripe and the site prints them, so a card
 *   can never advertise a number the checkout doesn't charge. The Stripe object IDs for each plan stay in
 *   the worker (`@mailwoman/license-worker/shop/ids`).
 */

/**
 * Days past the paid period's end a purchased key stays valid.
 */
export const GRACE_DAYS = 14

/**
 * The plan codes as a non-empty tuple, the shape a zod enum takes.
 *
 * A plan code is also the Stripe Price lookup key.
 */
export const SHOP_PLAN_CODES = ["commercial-monthly-v1", "commercial-yearly-v1"] as const

export type ShopPlanCode = (typeof SHOP_PLAN_CODES)[number]

export interface ShopPlan {
	code: ShopPlanCode
	interval: "month" | "year"
	/**
	 * In the currency's minor unit: cents.
	 */
	unitAmount: number
	currency: "usd"
}

/**
 * The published prices, also stated in `docs/articles/pricing.mdx`.
 */
export const SHOP_PLANS: readonly ShopPlan[] = [
	{ code: "commercial-monthly-v1", interval: "month", unitAmount: 25_000, currency: "usd" },
	{ code: "commercial-yearly-v1", interval: "year", unitAmount: 240_000, currency: "usd" },
]

/**
 * One formatter serves the site, so every printed figure comes from the same {@linkcode SHOP_PLANS} entry.
 */
function formatAmount(cents: number, currency: string): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: currency.toUpperCase(),
		maximumFractionDigits: 0,
	}).format(cents / 100)
}

/**
 * The plan with a code.
 *
 * @throws When the catalog has no such plan.
 */
export function shopPlan(code: ShopPlanCode): ShopPlan {
	const plan = SHOP_PLANS.find((candidate) => candidate.code === code)

	if (!plan) throw new Error(`No shop plan for ${code}`)

	return plan
}

const MONTHLY_PLAN = shopPlan("commercial-monthly-v1")
const YEARLY_PLAN = shopPlan("commercial-yearly-v1")

/**
 * The monthly plan's headline price, e.g. `$250`.
 */
export const PRICE_MONTHLY = formatAmount(MONTHLY_PLAN.unitAmount, MONTHLY_PLAN.currency)

/**
 * The yearly plan's headline price, e.g. `$2,400`.
 */
export const PRICE_YEARLY = formatAmount(YEARLY_PLAN.unitAmount, YEARLY_PLAN.currency)

/**
 * The yearly plan as an effective monthly rate, e.g. `$200`.
 */
export const PRICE_YEARLY_PER_MONTH = formatAmount(Math.round(YEARLY_PLAN.unitAmount / 12), YEARLY_PLAN.currency)
