// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The published versions of Mailwoman's commercial agreements, and the public addresses that
 *   serve and support them.
 *
 *   Each agreement version has one page under `docs/src/pages/license/terms/`, and a page is never
 *   edited after publication. A license key records the version its holder accepted, and a released
 *   artifact or historical record keeps the version it states.
 */

/**
 * The platform agreement a buyer accepts at checkout.
 *
 * Its grant covers platform use and inference with covered pretrained models,
 * and excludes the commercial training stack.
 * The checkout writes it into Payment Link metadata, and fulfillment records it on every purchased key.
 */
export const AGREEMENT_VERSION = "commercial-2026-11"

/**
 * The platform agreement checkout sold before {@linkcode AGREEMENT_VERSION}.
 *
 * Keys issued under it keep it.
 * Its page stays published at its own address.
 */
export const PREVIOUS_AGREEMENT_VERSIONS = ["commercial-2026-10"] as const

/**
 * The written training agreement a commercial training grant is issued under.
 *
 * It is negotiated and signed outside checkout, and the issuer writes its version into every grant.
 */
export const TRAINING_AGREEMENT_VERSION = "commercial-training-2026-11"

/**
 * The site path of an agreement version's page.
 */
export function agreementPath(version: string): string {
	return `/license/terms/${version}`
}

/**
 * The clickwrap agreement page for the current platform version.
 */
export const TERMS_PATH = agreementPath(AGREEMENT_VERSION)

/**
 * The license worker's origin: the claim route the issued page polls lives under it.
 */
export const LICENSE_WORKER_URL = "https://license.mailwoman.post"

/**
 * Where a buyer writes when the page cannot help.
 */
export const SUPPORT_EMAIL = "support@sister.software"
