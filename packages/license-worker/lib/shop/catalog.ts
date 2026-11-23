// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * This module defines shop configuration as data.
 *
 * `provision.ts` reconciles test and live Stripe accounts against it.
 * The worker's required objects are defined here instead of in a dashboard.
 *
 * Plan codes serve as Price lookup keys, so provisioning can find a Price
 * again without storing its id in git.
 */

import { AGREEMENT_VERSION, agreementPath } from "@mailwoman/license/product/agreement"
import type { ShopPlanCode } from "@mailwoman/license/product/plans"

/**
 * The Payment Link custom field that collects the licensee's legal name
 * and that the worker reads the session by.
 */
export const LICENSEE_FIELD_KEY = "licensee_legal_name"

/**
 * The Payment Link metadata key Stripe copies onto each Checkout Session.
 * The worker reads the agreement version from it.
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
 * Defines the fields Checkout collects beyond payment.
 *
 * The provisioner copies them into Payment Links and rehearsal Checkout Sessions
 * so both use the same collection settings.
 */
export interface CheckoutCollection {
	custom_fields: Array<{ key: string; label: { type: "custom"; custom: string }; type: "text" }>
	billing_address_collection: "required"
	consent_collection: { terms_of_service: "required" }
	/**
	 * The promotion-code field on the checkout page.
	 * The codes themselves live in the dashboard.
	 */
	allow_promotion_codes: true
	/**
	 * Stripe collects no card when a 100%-off first invoice requires no payment.
	 * It requests a card for the first invoice that charges.
	 */
	payment_method_collection: "if_required"
	metadata: Record<string, string>
}

/**
 * Lists the collection fields a Payment Link can change after creation.
 *
 * The provisioner updates these fields on an existing link.
 * A change to any other field requires a new link.
 */
export const RECONCILED_LINK_FIELDS = {
	allow_promotion_codes: true,
	payment_method_collection: "if_required",
} as const

export function checkoutCollection(planCode: ShopPlanCode): CheckoutCollection {
	return {
		custom_fields: [
			{ key: LICENSEE_FIELD_KEY, label: { type: "custom", custom: "Licensee legal name" }, type: "text" },
		],
		billing_address_collection: "required",
		consent_collection: { terms_of_service: "required" },
		...RECONCILED_LINK_FIELDS,
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

/**
 * The route the webhook destination posts to, on the worker's origin.
 */
export const WEBHOOK_PATH = "/v1/webhooks/stripe"

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
		termsURL: `${origin}${agreementPath(AGREEMENT_VERSION)}`,
		licenseURL: `${origin}/license`,
	}
}
