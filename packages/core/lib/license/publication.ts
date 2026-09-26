/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The freshness check against mailwoman.ai's well-known register is kept apart from the offline verification in
 *   `configured.ts` so a caller that needs only the offline answer never loads the HTTP client behind this one.
 */

import { APIClient, type APIClientConfig } from "#api/APIClient"
import { ResourceError } from "#errors/schema"
import { docsSiteURL } from "#license/docs-site"
import type { PublishedLicenseKeys } from "#license/register"
import { silentLogger } from "#logging/index"

/**
 * Path of the well-known register that lists published signing keys.
 */
export const LICENSE_KEYS_WELL_KNOWN_PATH = "/.well-known/mailwoman/license-keys.json"

export function licenseKeysWellKnownURL(): string {
	return `${docsSiteURL()}${LICENSE_KEYS_WELL_KNOWN_PATH}`
}

/**
 * Whether mailwoman.ai still lists a key id as active.
 *
 * `unreachable` is a network answer while `unpublished` means the site answered without
 * a register to give, and offline verification stands under both.
 */
export type LicenseKeyPublication = "listed" | "retired" | "unlisted" | "unpublished" | "unreachable"

export interface ConfirmLicenseKeyPublishedOptions {
	timeoutMs?: number
	url?: string
	/**
	 * Transport overrides, for a test that scripts the wire (`@mailwoman/core/api/test-transport`).
	 */
	axios?: APIClientConfig["axios"]
}

const HTTP_BAD_REQUEST = 400
const HTTP_INTERNAL_SERVER_ERROR = 500

/**
 * The site's own word that no resource is at the path: a 4xx, where a 5xx is `unreachable`.
 */
function siteAnsweredWithout(error: unknown): boolean {
	return error instanceof ResourceError && error.status >= HTTP_BAD_REQUEST && error.status < HTTP_INTERNAL_SERVER_ERROR
}

/**
 * A register, by shape: anything else the site hands back at the path
 * (a soft 404 page, a redirect's html) is not one, whatever status it came with.
 */
function isRegister(document: unknown): document is Pick<PublishedLicenseKeys, "keys"> {
	return typeof document === "object" && document !== null && Array.isArray((document as { keys?: unknown }).keys)
}

/**
 * Ask the well-known register about one key id, bounded to a few seconds
 * so a doctor run without a route to mailwoman.ai does not hang on it.
 */
export async function confirmLicenseKeyPublished(
	kid: string,
	options: ConfirmLicenseKeyPublishedOptions = {}
): Promise<LicenseKeyPublication> {
	await using client = new APIClient({
		displayName: "license-keys",
		// The doctor and `license verify --json` own stdout: the client's request line must not land in the document.
		logger: silentLogger(),
		axios: { headers: { accept: "application/json" }, timeout: options.timeoutMs ?? 3000, ...options.axios },
	})

	let document: unknown

	try {
		document = (await client.fetch<unknown>({ url: options.url ?? licenseKeysWellKnownURL() })).data
	} catch (error) {
		return siteAnsweredWithout(error) ? "unpublished" : "unreachable"
	}

	if (!isRegister(document)) return "unpublished"

	const entry = document.keys.find((key) => key.kid === kid)

	if (!entry) return "unlisted"

	return entry.status === "active" ? "listed" : "retired"
}
