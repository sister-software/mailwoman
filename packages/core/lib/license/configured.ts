/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The license key this installation has configured, verified offline against the shipped trusted keys. The token is
 *   `MAILWOMAN_LICENSE_KEY` first and the config-root key file second, so a key `mailwoman license refresh` wrote
 *   applies without an environment change. The optional freshness check against the well-known register is
 *   `publication.ts`, kept apart because it carries the HTTP client and this module is on the CLI launcher's path for
 *   every invocation.
 */

import { verifyLicenseKey, type LicenseKeyVerification } from "#license/key"
import { readConfiguredLicenseToken } from "#license/key-file"
import { trustedLicenseSigningKeys } from "#license/register"

/**
 * Verify the configured key offline, or `undefined` when neither the variable nor the key file is set.
 */
export async function verifyConfiguredLicenseKey(now?: Date): Promise<LicenseKeyVerification | undefined> {
	const configured = await readConfiguredLicenseToken()

	if (!configured) return undefined

	return await verifyLicenseKey(configured.token, {
		trustedKeys: trustedLicenseSigningKeys(),
		...(now ? { now } : {}),
	})
}
