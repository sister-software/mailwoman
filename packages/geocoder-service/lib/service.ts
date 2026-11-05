/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Chooses which geocoder provider answers each query.
 */

import { type ConnectivityReading, offlineReason, offlineResourceError } from "@mailwoman/core/network/connectivity"

import type { GeocoderProvider, ProviderPlacement } from "#provider"

/**
 * The milliseconds the service waits for the remote provider before it asks a ready local provider instead.
 *
 * The deadline applies only while a local provider is ready.
 * Without one, the remote provider is the only source of an answer,
 * so the service waits for it until the caller cancels.
 */
export const DEFAULT_REMOTE_DEADLINE_MS = 6000

export interface GeocoderServiceOptions<Q, A> {
	remote?: GeocoderProvider<Q, A> | null
	local?: GeocoderProvider<Q, A> | null

	/**
	 * The current connectivity reading, read once per query.
	 */
	connectivity: () => ConnectivityReading

	/**
	 * @see {@linkcode DEFAULT_REMOTE_DEADLINE_MS}
	 */
	remoteDeadlineMs?: number

	/**
	 * Called when the remote provider fails in a way {@linkcode isUnavailableError} recognizes, so the
	 * owner of the connectivity reading can test reachability again before the next scheduled probe.
	 */
	onRemoteUnavailable?: (error: unknown) => void
}

/**
 * A provider's answer to a query.
 */
export interface GeocodeOutcome<A> {
	answer: A
	providerID: string
	placement: ProviderPlacement

	/**
	 * The remote provider's failure when the local provider answered in its place, and `null` otherwise.
	 */
	remoteError: unknown
}

export interface GeocodeOptions {
	signal?: AbortSignal
	onStage?: (stage: number) => void
}

/**
 * The lowest HTTP status that reports a server failure rather than a refusal of the request.
 */
const FIRST_SERVER_ERROR_STATUS = 500

/**
 * HTTP 429: the API Worker's rate limiter refused this client for a period,
 * and another provider can still answer.
 */
const TOO_MANY_REQUESTS_STATUS = 429

/**
 * Whether an error reports that the remote provider was unreachable or failed,
 * as opposed to refusing the query.
 *
 * A network failure, a timeout, a 5xx status and a 429 qualify.
 * A 4xx status other than 429 means the service answered and refused this query,
 * and asking another provider would hide that refusal.
 *
 * `APIClient` assigns status 503 or 504 to a `ResourceError` of kind `network`,
 * so the status test covers it.
 * A call to `resourceErrorKind` would read the same kind from the URN,
 * and it would bring axios into the browser bundle.
 */
export function isUnavailableError(error: unknown): boolean {
	// `fetch` rejects with a `TypeError` when the request reaches no response.
	if (error instanceof TypeError) return true

	if (error instanceof Error && error.name === "TimeoutError") return true

	const status = (error as { status?: unknown } | null)?.status

	if (typeof status === "number") return status >= FIRST_SERVER_ERROR_STATUS || status === TOO_MANY_REQUESTS_STATUS

	return false
}

/**
 * Answers geocode queries from a remote provider, a local provider, or both.
 *
 * Each query goes to the remote provider first when the connectivity reading
 * allows a request, and to a ready local provider when the reading rules one out,
 * the remote attempt fails with an unavailable error, or the remote deadline passes.
 * A query that no provider can answer rejects with the remote error, or with a
 * `connectivity:network:<reason>` `ResourceError` when the reading ruled out the request.
 *
 * The service holds no assets, cache or connectivity probe of its own, so each provider
 * and the reachability probe can be tested and replaced on their own.
 */
export class GeocoderService<Q, A> {
	readonly #remote: GeocoderProvider<Q, A> | null
	readonly #local: GeocoderProvider<Q, A> | null
	readonly #connectivity: () => ConnectivityReading
	readonly #remoteDeadlineMs: number
	readonly #onRemoteUnavailable: ((error: unknown) => void) | null

	constructor(options: GeocoderServiceOptions<Q, A>) {
		this.#remote = options.remote ?? null
		this.#local = options.local ?? null
		this.#connectivity = options.connectivity
		this.#remoteDeadlineMs = options.remoteDeadlineMs ?? DEFAULT_REMOTE_DEADLINE_MS
		this.#onRemoteUnavailable = options.onRemoteUnavailable ?? null
	}

	public geocode = async (query: Q, options: GeocodeOptions = {}): Promise<GeocodeOutcome<A>> => {
		const callerSignal = options.signal ?? new AbortController().signal
		const onStage = options.onStage ?? (() => {})
		const remote = this.#remote?.isReady() ? this.#remote : null
		const local = this.#local?.isReady() ? this.#local : null
		const ruledOut = offlineReason(this.#connectivity())

		if (remote && !ruledOut) {
			const signal = local ? AbortSignal.any([callerSignal, AbortSignal.timeout(this.#remoteDeadlineMs)]) : callerSignal

			try {
				const answer = await remote.geocode(query, { signal, onStage })

				return { answer, providerID: remote.id, placement: remote.placement, remoteError: null }
			} catch (error) {
				if (callerSignal.aborted) throw error

				// The engine reports the deadline's abort with an error of its own, such as `fetch`'s `AbortError`.
				const unavailable = isUnavailableError(error) || (signal !== callerSignal && signal.aborted)

				if (!unavailable) throw error

				this.#onRemoteUnavailable?.(error)

				if (!local) throw error

				const answer = await local.geocode(query, { signal: callerSignal, onStage })

				return { answer, providerID: local.id, placement: local.placement, remoteError: error }
			}
		}

		if (local) {
			const answer = await local.geocode(query, { signal: callerSignal, onStage })

			return { answer, providerID: local.id, placement: local.placement, remoteError: null }
		}

		if (ruledOut) throw offlineResourceError(ruledOut)

		throw new Error("No geocoder provider is ready.")
	}
}
