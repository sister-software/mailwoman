/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The stamp contains no licensee or key ID. It works offline by design.
 *   The well-known register supplies the doctor's freshness check, so each process makes no network call.
 */

import { docsSiteURL } from "#license/docs-site"
import type { LicenseKeyVerification } from "#license/key"
import { appliedLicenseBranch } from "#license/obligations"

/**
 * The singular page path the notice and the `Link: rel="license"` header point at,
 * matching `license_url` and the `license` command.
 */
export const LICENSE_PAGE_PATH = "/license"

/**
 * The AGPL source offer to network users.
 * The commercial agreement waives this obligation.
 */
const NOTICE_OBLIGATION = "modified or network-served copies must offer their source."
const NOTICE_REMEDY = "A commercial license waives that obligation"

/**
 * The wire shape every stamped output uses, keyed in snake case.
 */
export interface EngineStamp {
	name: "mailwoman"
	version: string
	/**
	 * The license branch that applies to this installation: `AGPL-3.0-only`,
	 * or `LicenseRef-Commercial` when the configured key verifies.
	 */
	license: string
	license_url: string
	notice?: string
}

export function licensePageURL(docsURL?: string): string {
	return `${docsSiteURL(docsURL)}${LICENSE_PAGE_PATH}`
}

function noticeSentence(license: string, expiredOn?: string): string {
	const qualifier = expiredOn ? ` (the configured license key expired on ${expiredOn})` : ""

	return `mailwoman is licensed ${license}${qualifier}: ${NOTICE_OBLIGATION}`
}

/**
 * Build the offline stamp, taking the branch from `appliedLicenseBranch` —
 * the function the doctor calls too — so the two agree by construction.
 */
export function buildEngineStamp(input: {
	version: string
	expression: string
	key?: LicenseKeyVerification
}): EngineStamp {
	const commercial = input.key?.status === "valid"
	const license = appliedLicenseBranch(input.expression, input.key)

	return {
		name: "mailwoman",
		version: input.version,
		license,
		license_url: licensePageURL(),
		...(commercial ? {} : { notice: `${noticeSentence(license)} ${NOTICE_REMEDY}.` }),
	}
}

/**
 * The stderr notice: two lines, or no notice when the commercial branch applies.
 *
 * An expired key states its date because that tells the operator what to do,
 * while every other failed reading leaves the reason to `mailwoman doctor`.
 */
export function licenseNoticeLines(stamp: EngineStamp, key?: LicenseKeyVerification): [string, string] | null {
	if (!stamp.notice) return null

	const expiredOn = key?.status === "expired" ? key.payload.expires : undefined

	return [noticeSentence(stamp.license, expiredOn), `${NOTICE_REMEDY}: ${stamp.license_url}`]
}
