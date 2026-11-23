// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The live Stripe addresses the site links to: the two Payment Links and the billing portal.
 *
 *   The agreement version, the support address and the printed prices are vendor-neutral
 *   and belong to `@mailwoman/license/product`.
 */

import { SHOP_IDS } from "#shop/ids"

/**
 * Monthly Payment Link.
 */
export const PAYMENT_LINK_MONTHLY = SHOP_IDS.live.paymentLinks["commercial-monthly-v1"]

/**
 * Yearly Payment Link.
 */
export const PAYMENT_LINK_YEARLY = SHOP_IDS.live.paymentLinks["commercial-yearly-v1"]

/**
 * The Customer Portal's login page, where a customer changes the card, the plan, or cancels.
 */
export const BILLING_PORTAL_URL = SHOP_IDS.live.portalURL
