/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shop as data: the one Product, the two Prices, the shape of a Payment Link, the portal's features and the
 *   webhook's events. `provision.ts` reconciles a Stripe account against it, test mode and live mode alike, so the
 *   objects the worker depends on are defined here and nowhere in a dashboard. The plan codes are the Price lookup keys,
 *   which is how a provisioned Price is found again without an id in git.
 */

import type { CommercialPlan } from "#plans"

/**
 * The agreement version the Payment Links carry as metadata and the worker records on every license. Bumping it is a
 * new terms page, new Payment Links, and a new value in each environment's `AGREEMENT_VERSION`.
 */
export const AGREEMENT_VERSION = "commercial-2026-10"

/**
 * The Payment Link custom field that collects the licensee's legal name; the worker reads the session field by this
 * key.
 */
export const LICENSEE_FIELD_KEY = "licensee_legal_name"

/**
 * The Payment Link metadata key Stripe copies onto each Checkout Session; the worker reads the agreement version from
 * it.
 */
export const AGREEMENT_METADATA_KEY = "agreement_version"

/**
 * The metadata key that marks the Product and the Payment Links as this shop's, so a re-run finds them.
 */
export const SHOP_METADATA_KEY = "mailwoman_shop"

/**
 * The value under `SHOP_METADATA_KEY`.
 */
export const SHOP_MARK = "commercial-license"

/**
 * What Checkout collects from a buyer beyond the payment, spread into a Payment Link and into a Checkout Session built
 * for a rehearsal alike: the licensee's legal name, a billing address, consent to the terms, and the metadata the
 * worker reads a session by. One function, so the two cannot drift.
 */
export interface CheckoutCollection {
	custom_fields: Array<{ key: string; label: { type: "custom"; custom: string }; type: "text" }>
	billing_address_collection: "required"
	consent_collection: { terms_of_service: "required" }
	/**
	 * The promotion-code field on the checkout page; the codes themselves live in the dashboard.
	 */
	allow_promotion_codes: true
	metadata: Record<string, string>
}

export function checkoutCollection(planCode: ShopPlan["code"]): CheckoutCollection {
	return {
		custom_fields: [
			{ key: LICENSEE_FIELD_KEY, label: { type: "custom", custom: "Licensee legal name" }, type: "text" },
		],
		billing_address_collection: "required",
		consent_collection: { terms_of_service: "required" },
		allow_promotion_codes: true,
		metadata: { [SHOP_METADATA_KEY]: SHOP_MARK, plan_code: planCode, [AGREEMENT_METADATA_KEY]: AGREEMENT_VERSION },
	}
}

/**
 * The one Product both Prices belong to, as the dashboard and the receipts name it.
 */
export const SHOP_PRODUCT = {
	name: "Mailwoman commercial license",
	description:
		"Waives the AGPL share-alike and source-offer obligations for one legal entity. Renews with the subscription; the license key follows the paid period plus 14 days.",
} as const

export interface ShopPlan {
	code: CommercialPlan["code"]
	interval: "month" | "year"
	/**
	 * In the currency's minor unit: cents.
	 */
	unitAmount: number
	currency: "usd"
}

/**
 * The published prices: $250 a month, $2,400 a year (`docs/articles/pricing.mdx`).
 */
export const SHOP_PLANS: readonly ShopPlan[] = [
	{ code: "commercial-monthly-v1", interval: "month", unitAmount: 25_000, currency: "usd" },
	{ code: "commercial-yearly-v1", interval: "year", unitAmount: 240_000, currency: "usd" },
]

/**
 * The route the webhook destination posts to, on the worker's origin.
 */
export const WEBHOOK_PATH = "/v1/webhooks/stripe"

/**
 * The events the webhook destination subscribes to: the ones the worker acts on, and no more.
 */
export { ACCEPTED_EVENT_TYPES as WEBHOOK_EVENTS } from "#stripe/webhook"

export interface ShopURLs {
	/**
	 * Where Checkout returns the buyer: the claim page, with Stripe's session id placeholder.
	 */
	successURL: string
	/**
	 * The clickwrap agreement for `AGREEMENT_VERSION`.
	 */
	termsURL: string
	/**
	 * The license page, where the portal returns the customer.
	 */
	licenseURL: string
}

export function shopURLs(siteOrigin: string): ShopURLs {
	const origin = siteOrigin.replace(/\/$/u, "")

	return {
		successURL: `${origin}/license/issued?session_id={CHECKOUT_SESSION_ID}`,
		termsURL: `${origin}/license/terms/${AGREEMENT_VERSION}`,
		licenseURL: `${origin}/license`,
	}
}
