/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The engine stamp: which mailwoman produced a response, and under which license branch. It rides in JSON bodies as
 *   `engine`, in two HTTP headers, and as a two-line stderr notice. It is built once per process from two inputs the
 *   doctor also reads — the package's license expression and the configured key's offline verification — so the doctor
 *   and every stamped output agree on the branch by construction.
 *
 *   The stamp carries no licensee and no key id. A deployment serving the public must not carry its operator's
 *   commercial relationship in every response; the doctor prints those two locally. It is offline: the well-known
 *   register is the doctor's freshness check, not a per-process network call.
 */

import type { LicenseKeyVerification } from "#license/key"
import { chooseLicenseBranch } from "#license/obligations"

/**
 * Where the docs site lives when `MAILWOMAN_DOCS_URL` is unset; the same default `licenseKeysWellKnownURL` applies.
 */
export const DEFAULT_DOCS_URL = "https://mailwoman.ai"

/**
 * The page the notice and the `Link: rel="license"` header point at. Singular, matching `license_url` and the `license`
 * command.
 */
export const LICENSE_PAGE_PATH = "/license"

/**
 * The obligation the notice states, in the doctor's vocabulary: the AGPL source offer to network users, which is the
 * one a network deployment carries and the one the commercial agreement waives.
 */
const NOTICE_OBLIGATION = "modified or network-served copies must offer their source."
const NOTICE_REMEDY = "A commercial license waives that obligation"

/**
 * What every stamped output carries. Snake-case keys: this is a wire shape.
 */
export interface EngineStamp {
	name: "mailwoman"
	version: string
	/**
	 * The license branch that applies to this installation: `AGPL-3.0-only`, or `LicenseRef-Commercial` when the
	 * configured key verifies.
	 */
	license: string
	license_url: string
	/**
	 * Present only when the open-source branch applies.
	 */
	notice?: string
}

export function licensePageURL(docsURL: string = DEFAULT_DOCS_URL): string {
	return `${docsURL.replace(/\/+$/u, "")}${LICENSE_PAGE_PATH}`
}

function noticeSentence(license: string, expiredOn?: string): string {
	const qualifier = expiredOn ? ` (the configured license key expired on ${expiredOn})` : ""

	return `mailwoman is licensed ${license}${qualifier}: ${NOTICE_OBLIGATION}`
}

/**
 * Build the stamp. `key` is the offline verification of the configured key, or absent when none is configured; only a
 * `valid` reading selects the commercial branch, the same rule `runtimeLicenseCheck` applies in the doctor.
 */
export function buildEngineStamp(input: {
	version: string
	expression: string
	key?: LicenseKeyVerification
	docsURL?: string
}): EngineStamp {
	const license = chooseLicenseBranch(input.expression, { commercialAgreement: input.key?.status === "valid" })
	const commercial = license.startsWith("LicenseRef-")

	return {
		name: "mailwoman",
		version: input.version,
		license,
		license_url: licensePageURL(input.docsURL),
		...(commercial ? {} : { notice: `${noticeSentence(license)} ${NOTICE_REMEDY}.` }),
	}
}

/**
 * The stderr notice: two lines, or nothing when the commercial branch applies. An expired key is the one reading whose
 * cause the notice states, because the date tells the operator what to do; every other failed reading leaves the reason
 * to `mailwoman doctor`.
 */
export function licenseNoticeLines(stamp: EngineStamp, key?: LicenseKeyVerification): [string, string] | undefined {
	if (!stamp.notice) return undefined

	const expiredOn = key?.status === "expired" ? key.payload.expires : undefined

	return [noticeSentence(stamp.license, expiredOn), `${NOTICE_REMEDY}: ${stamp.license_url}`]
}
