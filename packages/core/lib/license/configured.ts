/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The license key this installation has configured, verified offline against the shipped trusted keys. The optional
 *   freshness check against the well-known register is `publication.ts`, kept apart because it carries the HTTP client
 *   and this module is on the CLI launcher's path for every invocation.
 */

import { $public } from "#env"
import { verifyLicenseKey, type LicenseKeyVerification } from "#license/key"
import { TRUSTED_LICENSE_SIGNING_KEYS } from "#license/trusted-keys"

/**
 * Verify `MAILWOMAN_LICENSE_KEY` offline, or `undefined` when none is configured.
 */
export function verifyConfiguredLicenseKey(now?: Date): LicenseKeyVerification | undefined {
	const token = $public.MAILWOMAN_LICENSE_KEY

	if (!token) return undefined

	return verifyLicenseKey(token, { trustedKeys: TRUSTED_LICENSE_SIGNING_KEYS, ...(now ? { now } : {}) })
}
