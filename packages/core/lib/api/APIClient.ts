/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The default base for HTTP clients in this repository. It centralizes throttling, caching and error mapping.
 *   New clients extend or instantiate this class. See `agents.md`.
 */

import { isAsyncDisposable } from "async-init"
import Axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse, type CreateAxiosDefaults } from "axios"
import {
	type AxiosCacheInstance,
	type CacheAxiosResponse,
	type CacheOptions,
	setupCache,
} from "axios-cache-interceptor"

import { type ClockLike, systemClock } from "#api/clock"
import { RequestPacer } from "#api/pacer"
import { delegateAxiosError } from "#api/responses"
import {
	classifyAxiosFailure,
	type ResolvedRetryPolicy,
	resolveRetryPolicy,
	retryDelayMs,
	type RetryOptions,
} from "#api/retry"
import { ConsoleLogger, type IRuntimeLogger } from "#logging"

const MS_PER_MINUTE = 60_000

/**
 * Configuration for an API client.
 */
export interface APIClientConfig {
	displayName: string
	/**
	 * Where the client's own lines go.
	 *
	 * A caller that owns stdout passes `silentLogger()` or its own.
	 */
	logger?: IRuntimeLogger

	/**
	 * Cache storage belongs to its caller unless `disposeCacheStorage` is true.
	 */
	caching?: CacheOptions

	/**
	 * This option transfers cache storage ownership to the client.
	 * The default is false.
	 */
	disposeCacheStorage?: boolean

	/**
	 * How many requests to make per minute before enforcing a cooldown: a budget model —
	 * spend `requestsPerMinute` dispatches, then stall until the cooldown lapses.
	 *
	 * This cannot express a flat per-second rate.
	 * Many fair-access policies publish that limit.
	 * Use {@linkcode minRequestIntervalMs} for that.
	 *
	 * The two compose (both limits must clear) but you almost certainly want one.
	 */
	requestsPerMinute?: number

	/**
	 * The minimum spacing between two dispatches, in milliseconds — strict pacing with no burst allowance.
	 *
	 * Set this when an upstream publishes a flat rate (SEC edgar: 10 requests/second, enforced): `1000 / rate`.
	 * Unlike {@linkcode requestsPerMinute}, the bound applies under arbitrary concurrency — grants are
	 * reserved synchronously, so N callers racing in one turn are still spaced one interval apart.
	 *
	 * A token bucket cannot do this: capacity C admits `C + rate * 1s` inside a sliding
	 * second, so no non-zero capacity honors a flat cap.
	 */
	minRequestIntervalMs?: number

	/**
	 * Bounded retry with exponential backoff, honoring a response's `Retry-After`.
	 * Pass `true` for the defaults.
	 *
	 * OPT-IN and absent by default, so an `APIClient` without this makes exactly one attempt. 429/5xx/408
	 * and network-class failures (dropped socket, DNS, timeout, mid-body-transfer drop) are retried.
	 * A 403 never is, because it means the request failed to identify itself
	 * and retrying can only fail identically while burning rate budget.
	 */
	retry?: RetryOptions | boolean

	/**
	 * Time source for the pacer, cooldown timer and retry backoff.
	 *
	 * Defaults to {@linkcode systemClock}.
	 * Tests inject a fake clock to make timing deterministic and instant.
	 */
	clock?: ClockLike

	axios?: CreateAxiosDefaults
}

/**
 * A base class for Mailwoman API clients.
 *
 * It provides request pacing, response caching, bounded retries, mapped errors and integrated logging.
 */
export class APIClient<C extends APIClientConfig = APIClientConfig> extends EventTarget implements AsyncDisposable {
	public readonly config: C

	#cooldownWithResolvers: PromiseWithResolvers<void> | null = null
	#requestCountWithinCooldown = 0
	/**
	 * When the current budget window opened — the instant of its first dispatch rather than of the last one.
	 *
	 * The cooldown is measured from this time.
	 * That makes `requestsPerMinute` mean requests per minute.
	 */
	#windowStartedAt = 0

	readonly #clock: ClockLike
	readonly #pacer: RequestPacer | null
	readonly #retryPolicy: ResolvedRetryPolicy
	readonly #shutdown = new AbortController()
	readonly #requestsInFlight = new Set<Promise<void>>()
	readonly #disposeStorage: (() => void | PromiseLike<void>) | undefined
	#disposePromise: Promise<void> | null = null

	public get $cooldown(): Promise<void> {
		return this.#cooldownWithResolvers?.promise || Promise.resolve()
	}

	public readonly logger: IRuntimeLogger
	public readonly axios: AxiosInstance | AxiosCacheInstance

	constructor(config: C) {
		super()

		this.config = config
		this.logger = config.logger ?? ConsoleLogger.prefix(config.displayName)
		this.#clock = config.clock ?? systemClock
		this.#retryPolicy = resolveRetryPolicy(config.retry ?? null)
		this.#pacer = config.minRequestIntervalMs ? new RequestPacer(config.minRequestIntervalMs, this.#clock) : null

		// The pacing limit lives IN the adapter rather than in `fetch()`: `axios-cache-interceptor`
		// short-circuits a cache HIT by replacing `config.adapter` with its own `cachedAdapter`,
		// so anything installed here is reached only when the request is actually going to the network.
		// A check in `fetch()` would run after the cache interceptor and make every
		// cache hit burn a full pacer sleep.
		//
		// Retries are unaffected: each attempt re-enters `this.axios(...)`,
		// so each re-enters this adapter and takes its own grant.
		const delegateAdapter = Axios.getAdapter(config.axios?.adapter ?? Axios.defaults.adapter)

		const axiosInstance = Axios.create({
			...config.axios,
			adapter: async (requestConfig) => {
				await this.acquireDispatchSlot()
				this.#shutdown.signal.throwIfAborted()

				return delegateAdapter(requestConfig)
			},
		})

		// oxlint-disable-next-line unicorn/prefer-ternary -- the branches are multi-line client constructions
		if (config.caching) {
			this.axios = setupCache(axiosInstance, {
				debug: (msg) => {
					this.logger.info(msg)
				},
				ttl: 60 * 60 * 1000, // 1 hour
				...config.caching,
			})
		} else {
			this.axios = axiosInstance
		}

		const storedCache = config.caching?.storage

		if (config.disposeCacheStorage === true) {
			if (isAsyncDisposable(storedCache)) {
				this.#disposeStorage = () => storedCache[Symbol.asyncDispose]()
			} else if (storedCache && Symbol.dispose in storedCache) {
				const dispose = storedCache[Symbol.dispose]

				if (typeof dispose === "function") {
					this.#disposeStorage = () => dispose.call(storedCache)
				}
			}
		}

		this.axios.interceptors.request.use((requestConfig) => {
			this.#shutdown.signal.throwIfAborted()

			return requestConfig
		})

		this.axios.interceptors.response.use((response: CacheAxiosResponse | AxiosResponse) => {
			const cachedLabel = (response as CacheAxiosResponse).cached ? " (cached)" : "(uncached)"

			this.logger.debug(
				`${response.status} ${cachedLabel} ${response.config.method?.toUpperCase()}: ${response.config.url}`
			)

			return response
		})

		this.#windowStartedAt = this.#clock.now()
	}

	/**
	 * Performs a fetch through the API's Axios instance.
	 *
	 * Cache hits return from cache.
	 * Other requests are paced and subject to cooldown.
	 *
	 * Failed requests retry within the configured ceiling.
	 * A final failure becomes a {@linkcode ResourceError} with a numeric `status`
	 * and a `(source, kind, reason)` URN.
	 *
	 * Error mapping happens here rather than in a response interceptor so the retry loop
	 * can see the raw `AxiosError` (status and `Retry-After`) before it is summarized.
	 * The constructor installs pacing and cooldown in the adapter downstream of the cache.
	 *
	 * A cache hit incurs no cost.
	 * Each retry re-enters the adapter, so a retry burst cannot outrun the pacer.
	 */
	public fetch = async <T>(options: AxiosRequestConfig): Promise<AxiosResponse<T>> => {
		this.#shutdown.signal.throwIfAborted()

		const completed = Promise.withResolvers<void>()

		this.#requestsInFlight.add(completed.promise)

		try {
			return await this.#fetch<T>(options)
		} finally {
			this.#requestsInFlight.delete(completed.promise)
			completed.resolve()
		}
	}

	async #fetch<T>(options: AxiosRequestConfig): Promise<AxiosResponse<T>> {
		const method = options.method?.toUpperCase() || "GET"

		// `mergeConfig` prefers a per-request `adapter` over the instance default.
		// The instance adapter enforces pacing and cooldown, so a caller-supplied
		// adapter would dispatch without a grant.
		// The cache interceptor also swaps the adapter.
		// Its adapter lets a cache hit skip the grant check.
		// It receives merged config inside the interceptor chain, after this method hands over the request.
		// The request options omit the caller's adapter, so the interceptor keeps its adapter.
		const { adapter: _callerAdapter, ...safeOptions } = options

		for (let attempt = 1; ; attempt++) {
			this.#shutdown.signal.throwIfAborted()
			this.logger.debug(`${method}: ${options.url}`)

			try {
				return await this.axios(safeOptions)
			} catch (error) {
				const directive = classifyAxiosFailure(error)

				if (this.#shutdown.signal.aborted || !directive.retryable || attempt >= this.#retryPolicy.maxAttempts) {
					// Always throws — `Promise<never>` is assignable to this method's return type.
					return delegateAxiosError(error)
				}

				const waitMs = retryDelayMs(attempt, directive, this.#retryPolicy)

				this.logger.debug(
					`Retrying ${method} ${options.url} in ${waitMs}ms (attempt ${attempt}/${this.#retryPolicy.maxAttempts}).`
				)

				await this.#clock.sleep(waitMs, this.#shutdown.signal)
			}
		}
	}

	/**
	 * Acquire permission to dispatch one request, clearing both limits.
	 *
	 * Each limit reserves synchronously against its own state.
	 * Concurrent requests cannot bypass either limit.
	 *
	 * The loop reacquires the pacer on every pass.
	 * A grant applies to a specific instant.
	 *
	 * A grant becomes stale if its caller waits through a cooldown after obtaining it.
	 * Callers with stale grants would all spend them when the cooldown lifts.
	 *
	 * Each caller discards its stale grant and obtains a fresh one before dispatch.
	 * The pacer under-issues by one request per cooldown wait.
	 * This keeps the limit on the safe side.
	 */
	protected acquireDispatchSlot = async (): Promise<void> => {
		for (;;) {
			this.#shutdown.signal.throwIfAborted()
			await this.#pacer?.acquire(this.#shutdown.signal)
			this.#shutdown.signal.throwIfAborted()

			const pending = this.#cooldownWithResolvers

			if (!pending) {
				// Check and reserve in the same synchronous step: awaiting the limit and
				// then counting lets every caller queued behind the same microtask turn pass
				// a limit that only closes once one of them has counted.
				this.#reserveCooldownSlot()

				return
			}

			await pending.promise

			// Clear the cooldown we observed, if it is still current.
			// This is what terminates the loop once the timer resolved without opening a replacement.
			if (this.#cooldownWithResolvers === pending) {
				this.#cooldownWithResolvers = null
			}
		}
	}

	/**
	 * Count this dispatch against the {@linkcode APIClientConfig.requestsPerMinute} budget,
	 * opening a cooldown once the budget is spent.
	 *
	 * Synchronous by construction: it must run to completion before the next caller can observe the counter.
	 */
	#reserveCooldownSlot(): void {
		const { requestsPerMinute } = this.config

		if (!requestsPerMinute) return

		const now = this.#clock.now()

		// The first dispatch after a reset opens the window.
		// Everything below measures from that instant.
		if (this.#requestCountWithinCooldown === 0) {
			this.#windowStartedAt = now
		}

		this.#requestCountWithinCooldown++

		if (this.#requestCountWithinCooldown >= requestsPerMinute) {
			// Wait out the remainder OF the minute rather than `MS_PER_MINUTE / requestsPerMinute`,
			// which is the spacing between two requests rather than the length of the budget window.
			this.setCooldown(MS_PER_MINUTE - (now - this.#windowStartedAt))
		}
	}

	protected setCooldown = (nextCooldown: number): void => {
		this.#shutdown.signal.throwIfAborted()

		const nextCooldownWithResolvers = Promise.withResolvers<void>()

		this.#cooldownWithResolvers = nextCooldownWithResolvers
		this.dispatchEvent(new Event("cooldown_start"))

		void this.#clock
			.sleep(Math.max(nextCooldown, 0), this.#shutdown.signal)
			.then(() => {
				if (this.#shutdown.signal.aborted) return

				this.#requestCountWithinCooldown = 0

				if (this.#cooldownWithResolvers === nextCooldownWithResolvers) {
					this.#cooldownWithResolvers = null
				}

				nextCooldownWithResolvers.resolve()

				this.dispatchEvent(new Event("cooldown_end"))
			})
			.catch((error: unknown) => {
				if (!this.#shutdown.signal.aborted) {
					this.logger.error(error)
				}
			})
	}

	/**
	 * Disposal stops queued requests and waits for active fetches to complete.
	 *
	 * It then releases owned cache storage.
	 * Repeated calls return the same cleanup promise.
	 */
	public [Symbol.asyncDispose](): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise

		const completed = Promise.withResolvers<void>()

		this.#disposePromise = completed.promise
		this.#shutdown.abort(new Error(`${this.config.displayName}: API client is disposed`))

		const pending = this.#cooldownWithResolvers

		this.#cooldownWithResolvers = null
		pending?.resolve()

		void this.#disposeResources().then(completed.resolve, completed.reject)

		return completed.promise
	}

	async #disposeResources(): Promise<void> {
		await Promise.all(this.#requestsInFlight)
		await this.#disposeStorage?.()
	}

	public override toString() {
		return `${this.config.displayName} API Client`
	}
}
