/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The freshness check against the well-known register on mailwoman.ai: the one network call the license posture
 *   makes, kept apart from the offline verification in `configured.ts` so that a caller which only needs the offline
 *   answer — the CLI launcher's notice on every invocation — never loads the HTTP client behind this one.
 */

import { APIClient, type APIClientConfig } from "#api/APIClient"
import { ResourceError } from "#errors/schema"
import { docsSiteURL } from "#license/docs-site"
import type { PublishedLicenseKeys } from "#license/register"
import { silentLogger } from "#logging/index"

/**
 * The published register of signing keys.
 */
export const LICENSE_KEYS_WELL_KNOWN_PATH = "/.well-known/mailwoman/license-keys.json"

export function licenseKeysWellKnownURL(): string {
	return `${docsSiteURL()}${LICENSE_KEYS_WELL_KNOWN_PATH}`
}

/**
 * Whether mailwoman.ai still lists a key id as active. Two of the answers are not verdicts, and they stay apart because
 * they call for different actions: `unreachable` is a network answer (no route, a timeout, the site failing), where
 * `unpublished` means the site answered and had no register to give, which is a deployment that dropped the file.
 * Offline verification stands under both, and the doctor says which.
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
 * The site's own word that nothing is at the path: a 4xx. A 5xx says the site is failing, which is `unreachable`.
 */
function siteAnsweredWithout(error: unknown): boolean {
	return error instanceof ResourceError && error.status >= HTTP_BAD_REQUEST && error.status < HTTP_INTERNAL_SERVER_ERROR
}

/**
 * A register, by shape. Anything else the site hands back at the path (a soft 404 page, a redirect's HTML) is not one,
 * whatever status it came with.
 */
function isRegister(document: unknown): document is Pick<PublishedLicenseKeys, "keys"> {
	return typeof document === "object" && document !== null && Array.isArray((document as { keys?: unknown }).keys)
}

/**
 * Ask the well-known register about one key id. Bounded to a few seconds so a doctor run on a machine without a route
 * to mailwoman.ai does not hang on it.
 */
export async function confirmLicenseKeyPublished(
	kid: string,
	options: ConfirmLicenseKeyPublishedOptions = {}
): Promise<LicenseKeyPublication> {
	await using client = new APIClient({
		displayName: "license-keys",
		// The doctor and `license verify --json` own stdout; the client's request line must not land in the document.
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
