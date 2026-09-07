/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ids Stripe answered for the shop's objects, per mode, as data: `ids.json` beside this file is written by the
 *   provisioner and read by the worker (the Price allowlist) and by the site and the email (the Payment Links and the
 *   portal's login address). Nothing else names a Stripe id; a re-provisioned account changes this file and nothing
 *   else.
 */

import type { ShopPlan } from "#shop/catalog"
import ids from "#shop/ids.json" with { type: "json" }

export type ShopMode = "test" | "live"

export interface ShopIDs {
	prices: Record<ShopPlan["code"], string>
	paymentLinks: Record<ShopPlan["code"], string>
	/**
	 * The Customer Portal's login page.
	 */
	portalURL: string
}

export type ShopIDsByMode = Record<ShopMode, ShopIDs>

/**
 * The recorded ids per Stripe mode, as `ids.json` holds them; the provisioner is the only writer.
 */
export const SHOP_IDS: ShopIDsByMode = ids

/**
 * The next contents of `ids.json` after a provisioning run answered for `mode`: every id present replaces the recorded
 * one, an absent id leaves the recorded one standing.
 */
export function withShopIDs(
	current: ShopIDsByMode,
	mode: ShopMode,
	answered: {
		prices: Partial<Record<ShopPlan["code"], string>>
		paymentLinks: Partial<Record<ShopPlan["code"], string>>
		portalURL?: string
	}
): ShopIDsByMode {
	const section = current[mode]

	return {
		...current,
		[mode]: {
			prices: { ...section.prices, ...answered.prices },
			paymentLinks: { ...section.paymentLinks, ...answered.paymentLinks },
			portalURL: answered.portalURL ?? section.portalURL,
		},
	}
}
