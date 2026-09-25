/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Exposes the Stripe object IDs for each mode, stored in `ids.json` beside this file.
 *
 *   The provisioner writes `ids.json`. The worker reads the Price allowlist from it, and the site and
 *   emails read the Payment Links and portal URL. All other code gets Stripe IDs from this module, so
 *   re-provisioning an account changes only `ids.json`.
 */

import type { ShopPlan } from "#shop/catalog"
import ids from "#shop/ids.json" with { type: "json" }

/**
 * A Stripe API mode.
 */
export type ShopMode = "test" | "live"

/**
 * The Stripe object IDs for one mode.
 */
export interface ShopIDs {
	prices: Record<ShopPlan["code"], string>
	paymentLinks: Record<ShopPlan["code"], string>
	/**
	 * The Customer Portal login URL.
	 */
	portalURL: string
}

/**
 * Stripe object IDs keyed by mode.
 */
export type ShopIDsByMode = Record<ShopMode, ShopIDs>

/**
 * The recorded Stripe object IDs from `ids.json`.
 */
export const SHOP_IDS: ShopIDsByMode = ids

/**
 * Returns the next contents of `ids.json` after provisioning `mode`.
 *
 * Each ID in `answered` replaces the recorded ID, and each absent ID keeps its recorded value.
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
