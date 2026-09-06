/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * The license worker's origin: the claim route the issued page polls lives under it.
 */
export const LICENSE_WORKER_URL = "https://license.mailwoman.ai"

/**
 * Where a buyer writes when the page cannot help: an unknown session, a revoked license, a key that never arrived.
 */
export const SUPPORT_EMAIL = "support@sister.software"

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
 * Monthly Payment Link.
 */
export const PAYMENT_LINK_MONTHLY = "https://buy.stripe.com/00weVffho9G7bgfeMl9oc00"

/**
 * Yearly Payment Link.
 */
export const PAYMENT_LINK_YEARLY = "https://buy.stripe.com/5kQbJ3c5c05xdonaw59oc01"

/**
 * No-code Customer Portal login link.
 */
export const BILLING_PORTAL_URL: string | null = null
