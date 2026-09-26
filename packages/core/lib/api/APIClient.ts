/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The default base for http clients in this repo. Raw `fetch` duplicates throttling, caching, and
 *   error mapping that live here; new clients extend or instantiate this instead (see `agents.md`).
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
import { ConsoleLogger, type IRuntimeLogger } from "#logging/index"

export { type IRuntimeLogger } from "#logging/index"

const MS_PER_MINUTE = 60_000

/**
 * Configuration for an API client.
 */
export interface APIClientConfig {
	displayName: string
	/**
	 * Where the client's own lines go; a caller that owns stdout passes `silentLogger()` or its own.
	 */
	logger?: IRuntimeLogger

	caching?: CacheOptions

	/**
	 * How many requests to make per minute before enforcing a cooldown: a budget model —
	 * spend `requestsPerMinute` dispatches, then stall until the cooldown lapses.
	 *
	 * This cannot express a flat per-second rate, which is what most fair-access policies
	 * publish; use {@linkcode minRequestIntervalMs} for that.
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
	 * Bounded retry with exponential backoff, honoring a response's `Retry-After`;
	 * pass `true` for the defaults.
	 *
	 * OPT-IN and absent by default, so an `APIClient` without this makes exactly one attempt.
	 * 429/5xx/408 and network-class failures (dropped socket, DNS, timeout, mid-body-transfer drop)
	 * are retried; a 403 never is, because it means the request failed to identify itself
	 * and retrying can only fail identically while burning rate budget.
	 */
	retry?: RetryOptions | boolean

	/**
	 * Time source powering the pacer, the cooldown timer, and the retry backoff; defaults to
	 * {@linkcode systemClock}, and tests inject a fake clock so timing is deterministic and instant.
	 */
	clock?: ClockLike

	axios?: CreateAxiosDefaults
}

/**
 * A base class for API clients used in Mailwoman, providing request pacing,
 * response caching, bounded retry, mapped errors, and integrated logging.
 */
export class APIClient<C extends APIClientConfig = APIClientConfig> extends EventTarget implements AsyncDisposable {
	public readonly config: C

	#cooldownWithResolvers: PromiseWithResolvers<void> | null = null
	#requestCountWithinCooldown = 0
	/**
	 * When the current budget window opened — the instant of its first dispatch
	 * rather than of the last one; the cooldown is measured from here, which is what
	 * makes `requestsPerMinute` mean requests per minute.
	 */
	#windowStartedAt = 0

	readonly #clock: ClockLike
	readonly #pacer: RequestPacer | null
	readonly #retryPolicy: ResolvedRetryPolicy

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
		this.#retryPolicy = resolveRetryPolicy(config.retry)
		this.#pacer = config.minRequestIntervalMs ? new RequestPacer(config.minRequestIntervalMs, this.#clock) : null

		// The pacing limit lives IN the adapter rather than in `fetch()`: `axios-cache-interceptor`
		// short-circuits a cache HIT by replacing `config.adapter` with its own `cachedAdapter`,
		// so anything installed here is reached only when the request is actually going to the network.
		// Restricting in `fetch()` instead put the cache interceptor downstream of the check
		// and made every cache hit burn a full pacer sleep.
		//
		// Retries are unaffected: each attempt re-enters `this.axios(...)`,
		// so each re-enters this adapter and takes its own grant.
		const delegateAdapter = Axios.getAdapter(config.axios?.adapter ?? Axios.defaults.adapter)

		const axiosInstance = Axios.create({
			...config.axios,
			adapter: async (requestConfig) => {
				await this.acquireDispatchSlot()

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
	 * Perform a fetch operation using the API's Axios instance: served from cache when possible,
	 * paced and cooldown-conditional when not, retried within the configured ceiling,
	 * and — on the final failure — mapped to a {@linkcode ResourceError} carrying a
	 * numeric `status` and a `(source, kind, reason)` URN.
	 *
	 * Error mapping happens here rather than in a response interceptor so the retry loop
	 * can see the raw `AxiosError` (status and `Retry-After`) before it is summarized.
	 * The pacing/cooldown limit deliberately sits in the adapter (see the constructor),
	 * downstream of the cache, so a hit incurs no cost and every retry attempt
	 * re-enters it — a retry burst cannot outrun the pacer.
	 */
	public fetch = async <T>(options: AxiosRequestConfig): Promise<AxiosResponse<T>> => {
		const method = options.method?.toUpperCase() || "GET"

		// A per-request `adapter` would win over the instance default in `mergeConfig`,
		// and the pacing/cooldown limit lives in that instance adapter, so passing
		// one here would dispatch with no grant at all.
		// The cache interceptor swaps the adapter too, and that one is intended: it is how a cache
		// hit skips the check without spending a grant, and it swaps on the merged config from
		// inside the interceptor chain, after this method has already handed the request over.
		// Stripping it here closes the caller-supplied door without touching the interceptor's.
		const { adapter: _callerAdapter, ...safeOptions } = options

		for (let attempt = 1; ; attempt++) {
			this.logger.debug(`${method}: ${options.url}`)

			try {
				return await this.axios(safeOptions)
			} catch (error) {
				const directive = classifyAxiosFailure(error)

				if (!directive.retryable || attempt >= this.#retryPolicy.maxAttempts) {
					// Always throws — `Promise<never>` is assignable to this method's return type.
					return await delegateAxiosError(error)
				}

				const waitMs = retryDelayMs(attempt, directive, this.#retryPolicy)

				this.logger.debug(
					`Retrying ${method} ${options.url} in ${waitMs}ms (attempt ${attempt}/${this.#retryPolicy.maxAttempts}).`
				)

				await this.#clock.sleep(waitMs)
			}
		}
	}

	/**
	 * Acquire permission to dispatch one request, clearing both limits.
	 *
	 * Each reserves synchronously with respect to its own state, so concurrency cannot defeat either of them.
	 *
	 * The pacer is re-acquired on every pass of the loop rather than taken once up front:
	 * a grant is a claim on a specific instant, so blocking on a cooldown after taking one leaves
	 * it stale, and every caller holding a stale grant spends it the moment the cooldown lifts.
	 * Re-acquiring discards the stale grant — the pacer under-issues by one per cooldown wait,
	 * which is the safe direction — and takes a fresh one for the instant we actually dispatch.
	 */
	protected acquireDispatchSlot = async (): Promise<void> => {
		for (;;) {
			await this.#pacer?.acquire()

			const pending = this.#cooldownWithResolvers

			if (!pending) {
				// Check and reserve in the same synchronous step: awaiting the limit and
				// then counting lets every caller queued behind the same microtask turn pass
				// a limit that only closes once one of them has counted.
				this.#reserveCooldownSlot()

				return
			}

			await pending.promise

			// Clear the cooldown we observed, if it is still current — this is what terminates
			// the loop once the timer resolved without opening a replacement.
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

		// The first dispatch after a reset opens the window; everything below measures from that instant.
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
		const nextCooldownWithResolvers = Promise.withResolvers<void>()

		this.#cooldownWithResolvers = nextCooldownWithResolvers
		this.dispatchEvent(new Event("cooldown_start"))

		void this.#clock.sleep(Math.max(nextCooldown, 0)).then(() => {
			this.#requestCountWithinCooldown = 0

			if (this.#cooldownWithResolvers === nextCooldownWithResolvers) {
				this.#cooldownWithResolvers = null
			}

			nextCooldownWithResolvers.resolve()

			this.dispatchEvent(new Event("cooldown_end"))
		})
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		const pending = this.#cooldownWithResolvers

		this.#cooldownWithResolvers = null
		pending?.resolve()

		const storedCache = this.config.caching?.storage

		if (isAsyncDisposable(storedCache)) {
			await storedCache[Symbol.asyncDispose]()
		}
	}

	public override toString() {
		return `${this.config.displayName} API Client`
	}
}
