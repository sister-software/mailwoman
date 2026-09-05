/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The freshness check against the well-known register on mailwoman.ai: the one network call the license posture
 *   makes, kept apart from the offline verification in `configured.ts` so that a caller which only needs the offline
 *   answer — the CLI launcher's notice on every invocation — never loads the HTTP client behind this one.
 */

import { APIClient } from "#api/APIClient"
import { docsSiteURL } from "#license/docs-site"
import { silentLogger } from "#logging/index"

/**
 * The published register of signing keys.
 */
export const LICENSE_KEYS_WELL_KNOWN_PATH = "/.well-known/mailwoman/license-keys.json"

export function licenseKeysWellKnownURL(): string {
	return `${docsSiteURL()}${LICENSE_KEYS_WELL_KNOWN_PATH}`
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
