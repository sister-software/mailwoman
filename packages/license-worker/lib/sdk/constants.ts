/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AGREEMENT_VERSION, type ShopPlan, SHOP_PLANS } from "#shop/catalog"
import { SHOP_IDS } from "#shop/ids"

export { AGREEMENT_VERSION } from "#shop/catalog"

/**
 * The license worker's origin: the claim route the issued page polls lives under it.
 */
export const LICENSE_WORKER_URL = "https://license.mailwoman.ai"

/**
 * Where a buyer writes when the page cannot help: an unknown session,
 * a revoked license, a key that never arrived.
 */
export const SUPPORT_EMAIL = "support@sister.software"

/**
 * The clickwrap agreement page for the current version, one page per version,
 * never edited after publication.
 */
export const TERMS_PATH = `/license/terms/${AGREEMENT_VERSION}`

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

/**
 * `25_000` (cents) → `"$250"`, in the plan's own currency.
 *
 * One formatter, so every printed figure on the site comes from the same
 * `SHOP_PLANS` entry the provisioner sends to Stripe.
 */
function formatAmount(cents: number, currency: string): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: currency.toUpperCase(),
		maximumFractionDigits: 0,
	}).format(cents / 100)
}

function planOrThrow(code: ShopPlan["code"]): ShopPlan {
	const plan = SHOP_PLANS.find((candidate) => candidate.code === code)

	if (!plan) throw new Error(`No shop plan for ${code}`)

	return plan
}

const MONTHLY_PLAN = planOrThrow("commercial-monthly-v1")
const YEARLY_PLAN = planOrThrow("commercial-yearly-v1")

/**
 * The monthly plan's headline price, e.g. `$250`.
 *
 * The provide cards on `/license` used to carry no figure at all, which left the price on
 * `/docs/pricing` and the button that takes the money with nothing connecting them.
 * Deriving both from `SHOP_PLANS` means a price change reaches the card and Stripe together,
 * and a card can never advertise a number the checkout does not charge.
 */
export const PRICE_MONTHLY = formatAmount(MONTHLY_PLAN.unitAmount, MONTHLY_PLAN.currency)

/**
 * The yearly plan's headline price, e.g. `$2,400`.
 */
export const PRICE_YEARLY = formatAmount(YEARLY_PLAN.unitAmount, YEARLY_PLAN.currency)

/**
 * The yearly plan as an effective monthly rate, e.g. `$200` — the comparison a buyer
 * makes anyway, and the one `/docs/pricing` already prints in prose.
 */
export const PRICE_YEARLY_PER_MONTH = formatAmount(Math.round(YEARLY_PLAN.unitAmount / 12), YEARLY_PLAN.currency)
