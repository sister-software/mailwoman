/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AGREEMENT_VERSION } from "#shop/catalog"
import { SHOP_IDS } from "#shop/ids"

export { AGREEMENT_VERSION } from "#shop/catalog"

/**
 * The license worker's origin: the claim route the issued page polls lives under it.
 */
export const LICENSE_WORKER_URL = "https://license.mailwoman.ai"

/**
 * Where a buyer writes when the page cannot help: an unknown session, a revoked license, a key that never arrived.
 */
export const SUPPORT_EMAIL = "support@sister.software"

/**
 * The clickwrap agreement page for the current version, one page per version, never edited after publication.
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
 * No-code Customer Portal login link.
 */
export const BILLING_PORTAL_URL: string | null = null
