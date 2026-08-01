/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   API response utilities.
 */

import { AxiosError, HttpStatusCode, isAxiosError } from "axios"
import type { StatusCodes } from "http-status-codes"

import { ResourceError } from "../errors/schema.ts"
import { isRetryableStatus } from "./retry.ts"

/**
 * A response container, wrapping the actual response body.
 */
export interface ResponseContainer<Body> {
	data: Body
}

export type ResponseLike<Body> = ResponseContainer<Body> | Body

/**
 * Type-helper to pluck the response body, possibly from within an Axios response.
 *
 * This is useful when normalizing a new Axios response and a cached local response.
 *
 * @internal
 */
export type ExtractResponseData<T> = T extends ResponseContainer<infer Body> ? Body : T

function isResponseContainer<Body>(responseContainer: ResponseLike<Body>): responseContainer is ResponseContainer<Body>
function isResponseContainer<Body>(body: Body): body is Body

function isResponseContainer<Body>(input: ResponseLike<Body>): input is ResponseContainer<Body> {
	return typeof input === "object" && input !== null && "data" in input
}

/**
 * Helper function to pluck the response body from an Axios response.
 */
function pluckResponseBody<Body>(responseContainer: ResponseContainer<Body>): Body
function pluckResponseBody<Body>(rawBody: Body): Body

function pluckResponseBody<Body>(input: ResponseContainer<Body> | Body): Body {
	if (isResponseContainer(input)) return input.data

	return input
}

/**
 * Type-helper to recursively pluck the `data` property from a response body.
 *
 * This is useful when an API nests the actual response body within a `data` property.
 *
 * @internal
 */
export type ExtractResponseBodyData<Body> = Body extends {
	data: infer Data
}
	? ExtractResponseBodyData<Data>
	: Body

/**
 * Helper function to recursively pluck the `data` property from a response body.
 *
 * This is useful when an API nests the actual response body within a `data` property.
 *
 * @internal
 */
export function pluckResponseData<Body>(responseContainer: ResponseContainer<Body>): ExtractResponseBodyData<Body>

export function pluckResponseData<Body>(input: ResponseContainer<Body> | Body): ExtractResponseBodyData<Body> {
	const body = pluckResponseBody(input)

	if (isResponseContainer(body)) return pluckResponseData(body)

	return body as ExtractResponseBodyData<Body>
}

export function checkConnectivity(
	connectivityURL: URL | string = "https://connectivitycheck.gstatic.com/generate_204"
): Promise<boolean> {
	// `fetch` can be absent (or, in a hermetic test harness, stubbed to throw SYNCHRONOUSLY), in which
	// case the call never produces a promise for `.catch` to attach to. A connectivity PROBE failing
	// must never become the error the caller sees — it's a diagnostic, not the diagnosis.
	try {
		return fetch(connectivityURL, {
			method: "HEAD",
		}).then(
			(response) => response.ok,
			() => false
		)
	} catch {
		return Promise.resolve(false)
	}
}

/**
 * The `kind` component of a {@linkcode ResourceError}'s `(source, kind, reason)` URN, as produced by
 * {@linkcode delegateAxiosError}. This is the axis {@linkcode isTransientResourceError} branches on, so a caller never
 * has to pattern-match an error message.
 */
export const ResourceErrorKind = {
	/**
	 * The request never reached an HTTP response: a connect failure, a DNS failure, a timeout, or a body read that died
	 * mid-transfer.
	 */
	Network: "network",
	/**
	 * An HTTP response came back and carried a failing status.
	 */
	Response: "response",
	/**
	 * The request was rejected before (or independently of) the network — a caller-initiated cancel, a malformed config.
	 * Never transient: re-issuing the identical request can only fail identically.
	 */
	Request: "request",
} as const

/**
 * The `kind` component of a {@linkcode ResourceError}'s URN.
 */
export type ResourceErrorKind = (typeof ResourceErrorKind)[keyof typeof ResourceErrorKind]

/**
 * The `source` component every URN in this module carries — the machinery that produced the failure.
 */
const RESOURCE_ERROR_SOURCE = "axios"

/**
 * The URN component separator {@linkcode ResourceError} joins segments with.
 */
const URN_SEPARATOR = ":"

/**
 * The `kind` component of `error`'s URN, or `null` when it isn't a {@linkcode ResourceError} carrying one.
 *
 * Exposed so a caller can assert on the taxonomy directly (`kind === ResourceErrorKind.Network`) instead of splitting
 * the URN — or, worse, matching on `message` prose — at the call site.
 */
export function resourceErrorKind(error: unknown): ResourceErrorKind | null {
	if (!(error instanceof ResourceError)) return null

	const [, kind] = error.name.split(URN_SEPARATOR)

	switch (kind) {
		case ResourceErrorKind.Network:
		case ResourceErrorKind.Response:
		case ResourceErrorKind.Request:
			return kind
		default:
			return null
	}
}

/**
 * Whether `error` is the kind of failure a caller should REQUEUE rather than give up on — every network-class failure
 * (connect, DNS, timeout, mid-transfer drop) and every transient HTTP status (408/429/5xx).
 *
 * This stays `true` even after a client exhausted its OWN bounded attempts: the client's ceiling is a statement about
 * one call, while a caller's requeue is a new, separate attempt budget minutes or hours later. Callers branch on this
 * plus {@linkcode ResourceError.status} — 404 to skip, 403 to abort — and never on message text.
 */
export function isTransientResourceError(error: unknown): boolean {
	if (!(error instanceof ResourceError)) return false

	switch (resourceErrorKind(error)) {
		case ResourceErrorKind.Network:
			return true
		case ResourceErrorKind.Response:
			return isRetryableStatus(error.status)
		default:
			return false
	}
}

/**
 * Build a {@linkcode ResourceError} carrying the `(source, kind, reason)` URN AND the originating `AxiosError` as its
 * `cause`, so a debugger keeps the full Axios context (config, request, response) that the mapped error summarizes.
 */
function taggedResourceError(
	cause: AxiosError,
	status: number,
	message: string,
	kind: ResourceErrorKind,
	reason: string
): ResourceError {
	const resourceError = ResourceError.from(status as StatusCodes, message, RESOURCE_ERROR_SOURCE, kind, reason)

	resourceError.cause = cause

	return resourceError
}

/**
 * The `reason` component for a failing HTTP status, chosen so the common branches a caller cares about are nameable
 * without re-deriving them from the number.
 */
function responseReason(status: number): string {
	switch (status) {
		case HttpStatusCode.Unauthorized:
			return "unauthorized"
		case HttpStatusCode.Forbidden:
			return "forbidden"
		case HttpStatusCode.NotFound:
			return "not-found"
		case HttpStatusCode.TooManyRequests:
			return "rate-limited"
		default:
			return isRetryableStatus(status) ? "server-error" : "status"
	}
}

/**
 * Delegate Axios errors to an appropriate error handler.
 *
 * ALWAYS throws — every failure past this point is a {@linkcode ResourceError} carrying a numeric `status`, a `(source,
 * kind, reason)` URN on `name`, and the originating `AxiosError` on `cause`. A non-Axios error is rethrown untouched.
 *
 * An earlier version RETURNED (resolving the interceptor chain with `undefined`) for `ERR_CANCELED`/`ECONNABORTED`/
 * `ETIMEDOUT`, so a timed-out request surfaced as a missing response body rather than an error — the single most common
 * bulk-crawl failure, silently converted into a `TypeError` at the caller's first property access. It also fell through
 * to rethrowing the raw `AxiosError` for every non-401 HTTP status, which left `status`-based branching (404 → skip,
 * 403 → abort) reaching into `error.response` instead of the mapped taxonomy.
 *
 * @internal
 */
export async function delegateAxiosError(error: unknown): Promise<never> {
	if (!isAxiosError(error)) throw error

	const { response, code: networkErrorCode } = error

	if (response) {
		const { status } = response

		throw taggedResourceError(
			error,
			status,
			`${status} ${response.statusText || ""}`.trim() || `HTTP ${status}`,
			ResourceErrorKind.Response,
			responseReason(status)
		)
	}

	if (networkErrorCode === AxiosError.ERR_CANCELED) {
		throw taggedResourceError(
			error,
			HttpStatusCode.BadRequest,
			"The request was canceled by its caller.",
			ResourceErrorKind.Request,
			"canceled"
		)
	}

	if (networkErrorCode === AxiosError.ECONNABORTED || networkErrorCode === AxiosError.ETIMEDOUT) {
		throw taggedResourceError(
			error,
			HttpStatusCode.GatewayTimeout,
			`The request timed out before a response arrived (${error.config?.url ?? "unknown URL"}).`,
			ResourceErrorKind.Network,
			"timeout"
		)
	}

	if (networkErrorCode === "ENOTFOUND") {
		const internetReachable = await checkConnectivity()

		throw taggedResourceError(
			error,
			HttpStatusCode.ServiceUnavailable,
			internetReachable
				? `Could not resolve host (${error.config?.url ?? "unknown URL"}).`
				: "Could not reach host. Are we connected to the internet?",
			ResourceErrorKind.Network,
			"unreachable"
		)
	}

	if (!networkErrorCode) {
		throw taggedResourceError(
			error,
			HttpStatusCode.InternalServerError,
			"Internal Server Error",
			ResourceErrorKind.Response,
			"missing"
		)
	}

	// Everything left reached no response and wasn't cancelled: a dropped socket, a refused connection,
	// a TLS failure, a body read that died mid-transfer. All network-class, all worth another attempt.
	throw taggedResourceError(
		error,
		HttpStatusCode.ServiceUnavailable,
		`Service Unavailable (${networkErrorCode}): ${error.message}`,
		ResourceErrorKind.Network,
		"unavailable"
	)
}
