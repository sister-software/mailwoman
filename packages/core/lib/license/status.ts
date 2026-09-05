/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The client for the license worker's two customer routes: the per-license status a lid answers, and the refresh that
 *   trades a lid and its secret for the current token. Kept outside the `license` barrel like `publication.ts`, because
 *   it carries the HTTP client and the barrel sits on the CLI launcher's path. `unreachable` is a network answer, not a
 *   verdict: offline verification stands, and every caller says so.
 */

import type { CacheRequestConfig } from "axios-cache-interceptor"

import { APIClient, type APIClientConfig } from "#api/APIClient"
import { $public } from "#env"
import { ResourceError } from "#errors/schema"
import { silentLogger } from "#logging/index"

/**
 * The license worker when `MAILWOMAN_LICENSE_URL` is unset.
 */
const DEFAULT_LICENSE_URL = "https://license.mailwoman.ai"

/**
 * The worker's origin with no trailing slash, so a route path can be appended by concatenation.
 */
export function licenseWorkerURL(override: string | undefined = $public.MAILWOMAN_LICENSE_URL): string {
	return (override ?? DEFAULT_LICENSE_URL).replace(/\/+$/u, "")
}

/**
 * The four words the worker answers, plus the one the network adds.
 */
export type LicenseStatusAnswer = "active" | "lapsed" | "revoked" | "unknown" | "unreachable"

export type RefreshAnswer =
	| { status: "active"; token: string; issued: string; expires: string }
	| { status: "pending" | "lapsed" | "revoked" }
	| { status: "not_found" }
	| { status: "unreachable"; reason: string }

export interface LicenseWorkerClientOptions {
	timeoutMs?: number
	url?: string
	/**
	 * Transport overrides, for a test that scripts the wire (`@mailwoman/core/api/test-transport`).
	 */
	axios?: APIClientConfig["axios"]
}

/**
 * Bounded so a doctor run on a machine without a route to the worker does not hang on it.
 */
const DEFAULT_TIMEOUT_MS = 5000

const HTTP_NOT_FOUND = 404

const STATUS_WORDS: ReadonlySet<string> = new Set<LicenseStatusAnswer>(["active", "lapsed", "revoked", "unknown"])

/**
 * A POST with the interceptor's per-request cache switch off: neither route's answer may be served from a cache.
 */
function uncachedPost(url: string, data: unknown): CacheRequestConfig {
	return { url, method: "POST", data, cache: false }
}

function client(options: LicenseWorkerClientOptions): APIClient {
	return new APIClient({
		displayName: "license-worker",
		// The doctor and `license refresh --json` own stdout; the client's request line must not land in the document.
		logger: silentLogger(),
		axios: {
			baseURL: licenseWorkerURL(options.url),
			headers: { accept: "application/json", "content-type": "application/json" },
			timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			...options.axios,
		},
	})
}

function isStatusWord(word: string): word is Exclude<LicenseStatusAnswer, "unreachable"> {
	return STATUS_WORDS.has(word)
}

/**
 * Ask the worker for one license's public status. Any answer outside the four words, and any failure to answer, is
 * reported as what it is rather than as a verdict.
 */
export async function checkLicenseStatus(
	lid: string,
	options: LicenseWorkerClientOptions = {}
): Promise<LicenseStatusAnswer> {
	await using api = client(options)

	try {
		const response = await api.fetch<{ status?: unknown }>(uncachedPost("/v1/license-status", { lid }))
		const word = response.data.status

		return typeof word === "string" && isStatusWord(word) ? word : "unknown"
	} catch {
		return "unreachable"
	}
}

/**
 * Trade a lid and its secret for the current token. The worker answers the same 404 for an unknown lid and a wrong
 * secret, which is `not_found` here; the caller verifies the token offline before writing it anywhere.
 */
export async function refreshLicenseKey(
	credentials: { lid: string; secret: string },
	options: LicenseWorkerClientOptions = {}
): Promise<RefreshAnswer> {
	await using api = client(options)

	try {
		const response = await api.fetch<RefreshAnswer>(uncachedPost("/v1/licenses/refresh", credentials))

		return response.data
	} catch (error) {
		if (error instanceof ResourceError && error.status === HTTP_NOT_FOUND) return { status: "not_found" }

		return { status: "unreachable", reason: error instanceof Error ? error.message : String(error) }
	}
}
