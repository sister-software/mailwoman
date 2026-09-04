/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The license key this installation has configured, verified against the shipped trusted keys, and the optional
 *   freshness check against the well-known file on mailwoman.ai.
 */

import { APIClient } from "#api/APIClient"
import { $public } from "#env"
import { verifyLicenseKey, type LicenseKeyVerification } from "#license/key"
import { TRUSTED_LICENSE_SIGNING_KEYS } from "#license/trusted-keys"
import { silentLogger } from "#logging/index"

/**
 * Verify `MAILWOMAN_LICENSE_KEY` offline, or `undefined` when none is configured.
 */
export function verifyConfiguredLicenseKey(now?: Date): LicenseKeyVerification | undefined {
	const token = $public.MAILWOMAN_LICENSE_KEY

	if (!token) return undefined

	return verifyLicenseKey(token, { trustedKeys: TRUSTED_LICENSE_SIGNING_KEYS, ...(now ? { now } : {}) })
}

/**
 * The published register of signing keys.
 */
export const LICENSE_KEYS_WELL_KNOWN_PATH = "/.well-known/mailwoman/license-keys.json"

export function licenseKeysWellKnownURL(): string {
	const base = ($public.MAILWOMAN_DOCS_URL ?? "https://mailwoman.ai").replace(/\/+$/u, "")

	return `${base}${LICENSE_KEYS_WELL_KNOWN_PATH}`
}

/**
 * The shape of the well-known file.
 */
export interface PublishedLicenseKeys {
	format: "mailwoman-license-keys/1"
	keys: Array<{
		kid: string
		algorithm: "Ed25519"
		publicKey: string
		majorVersions: number[]
		status: "active" | "retired"
	}>
}

/**
 * Whether mailwoman.ai still lists a key id as active. `unreachable` is a network answer, not a verdict: offline
 * verification stands, and the doctor says so.
 */
export type LicenseKeyPublication = "listed" | "retired" | "unlisted" | "unreachable"

/**
 * Ask the well-known register about one key id. Bounded to a few seconds so a doctor run on a machine without a route
 * to mailwoman.ai does not hang on it.
 */
export async function confirmLicenseKeyPublished(
	kid: string,
	options: { timeoutMs?: number; url?: string } = {}
): Promise<LicenseKeyPublication> {
	await using client = new APIClient({
		displayName: "license-keys",
		// The doctor and `license verify --json` own stdout; the client's request line must not land in the document.
		logger: silentLogger(),
		axios: { headers: { accept: "application/json" }, timeout: options.timeoutMs ?? 3000 },
	})

	try {
		const response = await client.fetch<PublishedLicenseKeys>({ url: options.url ?? licenseKeysWellKnownURL() })
		const entry = response.data.keys.find((key) => key.kid === kid)

		if (!entry) return "unlisted"

		return entry.status === "active" ? "listed" : "retired"
	} catch {
		return "unreachable"
	}
}
