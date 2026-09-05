/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one place the site names the shop: where the license worker lives, which agreement version the Payment Links
 *   sell, and the operator-owned URLs. The Payment Links and the billing portal are created in the Stripe dashboard
 *   (the spec's issue A) and start `undefined`; the Buy section renders only once both links are set, so the live page
 *   never shows a button that goes nowhere. The worker's exact-origin CORS admits `https://mailwoman.ai`, which is why
 *   the claim page can call it directly.
 */

/**
 * The license worker's origin: the claim route the issued page polls lives under it.
 */
export const LICENSE_WORKER_URL = "https://license.mailwoman.ai"

/**
 * Where a buyer writes when the page cannot help: an unknown session, a revoked license, a key that never arrived.
 */
export const SUPPORT_EMAIL = "teffen@sister.software"

/**
 * The agreement version the current Payment Links carry as `agreement_version` metadata; the worker records it on each
 * license once and signs it into every token for that license's life.
 */
export const AGREEMENT_VERSION = "commercial-2026-10"

/**
 * The clickwrap agreement page for the current version, one page per version, never edited after publication.
 */
export const TERMS_PATH = `/license/terms/${AGREEMENT_VERSION}`

/**
 * Operator-owned: the monthly Payment Link. `undefined` until it exists.
 */
export const PAYMENT_LINK_MONTHLY: string | undefined = undefined

/**
 * Operator-owned: the yearly Payment Link. `undefined` until it exists.
 */
export const PAYMENT_LINK_YEARLY: string | undefined = undefined

/**
 * Operator-owned: the no-code Customer Portal login link. `undefined` until it exists.
 */
export const BILLING_PORTAL_URL: string | undefined = undefined

/**
 * Whether both Payment Links are set: the condition under which the Buy section renders.
 */
export function shopIsOpen(): boolean {
	return PAYMENT_LINK_MONTHLY !== undefined && PAYMENT_LINK_YEARLY !== undefined
}
