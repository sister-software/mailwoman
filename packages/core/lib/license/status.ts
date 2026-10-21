/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The client serves two routes on the license worker.
 *   The status route returns the public status for a license ID.
 *   The refresh route trades a license ID and secret for the current token.
 *   The client stays outside the `license` barrel like `publication.ts` because it imports the HTTP client.
 *   The barrel sits on the CLI launcher's path.
 *   `unreachable` is a network result rather than a license verdict.
 *   Callers report it as a network result.
 *   Offline verification stays valid.
 */

import type { CacheRequestConfig } from "axios-cache-interceptor"

import { APIClient, type APIClientConfig } from "#api/APIClient"
import { $public } from "#env"
import { ResourceError } from "#errors/schema"
import type {
	DeclarationAnswer,
	DeclarationClaimAnswer,
	DeclarationRequest,
	DownloadAnswer,
	DownloadRequest,
} from "#license/declaration"
import { silentLogger } from "#logging"
import { withoutTrailingSlashes } from "#strings/format"

/**
 * The license worker when `MAILWOMAN_LICENSE_URL` is unset.
 */
const DEFAULT_LICENSE_URL = "https://license.mailwoman.ai"

/**
 * The worker's origin with no trailing slash, so a route path can be appended by concatenation.
 */
export function licenseWorkerURL(override: string | undefined = $public.MAILWOMAN_LICENSE_URL): string {
	return withoutTrailingSlashes(override ?? DEFAULT_LICENSE_URL)
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
 * A post with the interceptor's per-request cache switch off: neither route's
 * answer may be served from a cache.
 */
function uncachedPost(url: string, data: unknown): CacheRequestConfig {
	return { url, method: "POST", data, cache: false }
}

function client(options: LicenseWorkerClientOptions): APIClient {
	return new APIClient({
		displayName: "license-worker",
		// The doctor and `license refresh --json` own stdout.
		// The client's request line must not land in the document.
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
 * Ask the worker for one license's public status.
 *
 * The function reports an unrecognized answer or a request failure by its own status value.
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
 * Trade a lid and its secret for the current token.
 *
 * The worker returns the same 404 for an unknown license ID and a wrong secret.
 * This function maps either response to `not_found`.
 *
 * The caller verifies the token offline before writing it anywhere.
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

/**
 * The interval between two polls of a declaration's claim while its token travels by email.
 */
export const DECLARATION_CLAIM_INTERVAL_MS = 3000

/**
 * How long the CLI polls a claim before telling the user to adopt the token from the message instead.
 */
export const DECLARATION_CLAIM_DEADLINE_MS = 120_000

const HTTP_BAD_REQUEST = 400
const HTTP_FORBIDDEN = 403
const HTTP_CONFLICT = 409
const HTTP_SERVICE_UNAVAILABLE = 503

/**
 * The `error` word of the worker's JSON body behind a refused response,
 * read from the Axios cause the API client keeps on the error.
 */
function refusalWord(error: ResourceError): string | null {
	const cause = error.cause as { response?: { data?: { error?: unknown } } } | undefined
	const word = cause?.response?.data?.error

	return typeof word === "string" ? word : null
}

function requestFailureReason(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * A GET with the interceptor's per-request cache switch off.
 */
function uncachedGet(url: string): CacheRequestConfig {
	return { url, method: "GET", cache: false }
}

/**
 * Post a declaration of intent.
 *
 * An open-source declaration answers `issued` with the token and its refresh secret.
 * The other intents answer `pending` with the claim to poll.
 *
 * A 400 is the worker refusing a field, read back as `refused`.
 */
export async function declareLicense(
	request: DeclarationRequest,
	options: LicenseWorkerClientOptions = {}
): Promise<DeclarationAnswer> {
	await using api = client(options)

	try {
		const response = await api.fetch<DeclarationAnswer>(uncachedPost("/v1/declarations", request))

		return response.data
	} catch (error) {
		if (error instanceof ResourceError && error.status === HTTP_BAD_REQUEST) {
			return { status: "refused", reason: refusalWord(error) ?? "refused" }
		}

		return { status: "unreachable", reason: requestFailureReason(error) }
	}
}

/**
 * Request a thirty-day evaluation for an address.
 *
 * The worker's 409, an address that has received its evaluation, reads back
 * as the `evaluation_exists` refusal.
 */
export async function requestEvaluation(
	request: { email: string; name: string; install?: string },
	options: LicenseWorkerClientOptions = {}
): Promise<DeclarationAnswer> {
	await using api = client(options)

	try {
		const response = await api.fetch<DeclarationAnswer>(uncachedPost("/v1/evaluations", request))

		return response.data
	} catch (error) {
		if (error instanceof ResourceError && error.status === HTTP_CONFLICT) {
			return { status: "refused", reason: "evaluation_exists" }
		}

		return { status: "unreachable", reason: requestFailureReason(error) }
	}
}

/**
 * Poll a declaration's claim once.
 *
 * The worker's 404 reads back as `not_found`.
 */
export async function claimDeclaration(
	claimID: string,
	options: LicenseWorkerClientOptions = {}
): Promise<DeclarationClaimAnswer> {
	await using api = client(options)

	try {
		const response = await api.fetch<DeclarationClaimAnswer>(
			uncachedGet(`/v1/declarations/${encodeURIComponent(claimID)}`)
		)

		return response.data
	} catch (error) {
		if (error instanceof ResourceError && error.status === HTTP_NOT_FOUND) return { status: "not_found" }

		return { status: "unreachable", reason: requestFailureReason(error) }
	}
}

/**
 * Ask for a presigned download of a paid artifact.
 *
 * A 403 and a 400 read back as `refused` with the worker's word, and a 503 as
 * `unavailable`, the worker before its bucket is provisioned.
 */
export async function requestDownload(
	request: DownloadRequest,
	options: LicenseWorkerClientOptions = {}
): Promise<DownloadAnswer> {
	await using api = client(options)

	try {
		const response = await api.fetch<DownloadAnswer>(uncachedPost("/v1/downloads", request))

		return response.data
	} catch (error) {
		if (error instanceof ResourceError) {
			if (error.status === HTTP_SERVICE_UNAVAILABLE) return { status: "unavailable" }

			if (error.status === HTTP_FORBIDDEN || error.status === HTTP_BAD_REQUEST) {
				return { status: "refused", reason: refusalWord(error) ?? "refused" }
			}
		}

		return { status: "unreachable", reason: requestFailureReason(error) }
	}
}
