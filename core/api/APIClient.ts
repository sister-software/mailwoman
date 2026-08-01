/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The default base for HTTP clients in this repo. Raw `fetch` duplicates throttling, caching, and
 *   error mapping that live here; new clients extend or instantiate this instead (see `AGENTS.md`).
 */

import { isAsyncDisposable } from "async-init"
import Axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse, type CreateAxiosDefaults } from "axios"
import {
	type AxiosCacheInstance,
	type CacheAxiosResponse,
	type CacheOptions,
	setupCache,
} from "axios-cache-interceptor"

import { ConsoleLogger, type IRuntimeLogger } from "../logging/index.ts"
import { type ClockLike, systemClock } from "./clock.ts"
import { RequestPacer } from "./pacer.ts"
import { delegateAxiosError } from "./responses.ts"
import {
	classifyAxiosFailure,
	type ResolvedRetryPolicy,
	resolveRetryPolicy,
	retryDelayMs,
	type RetryOptions,
} from "./retry.ts"

export { type IRuntimeLogger } from "../logging/index.ts"

/**
 * Milliseconds in a minute — the numerator when turning {@linkcode APIClientConfig.requestsPerMinute} into an interval.
 */
const MS_PER_MINUTE = 60_000

/**
 * Configuration for an API client.
 */
export interface APIClientConfig {
	/**
	 * The logged display name of the API client.
	 */
	displayName: string

	/**
	 * Options for caching responses.
	 */
	caching?: CacheOptions

	/**
	 * How many requests to make per minute before enforcing a cooldown: a BUDGET model — spend `requestsPerMinute`
	 * dispatches, then stall until the cooldown lapses.
	 *
	 * This cannot express a flat per-second rate, which is what most fair-access policies actually publish. For that use
	 * {@linkcode minRequestIntervalMs}; the two compose (both gates must clear) but you almost certainly want one.
	 */
	requestsPerMinute?: number

	/**
	 * The minimum spacing between two dispatches, in milliseconds — strict pacing with NO burst allowance.
	 *
	 * Set this when an upstream publishes a flat rate (SEC EDGAR: 10 requests/second, enforced): `1000 / rate`. Unlike
	 * {@linkcode requestsPerMinute}, the guarantee holds under arbitrary concurrency — grants are reserved synchronously,
	 * so N callers racing in one turn are still spaced one interval apart. A token bucket cannot do this: capacity C
	 * admits `C + rate * 1s` inside a sliding second, so no non-zero capacity honors a flat cap.
	 */
	minRequestIntervalMs?: number

	/**
	 * Bounded retry with exponential backoff, honoring a response's `Retry-After`. Pass `true` for the defaults.
	 *
	 * OPT-IN, and absent by default: an `APIClient` without this makes exactly one attempt, which is what every existing
	 * consumer has always done. 429/5xx/408 and network-class failures (dropped socket, DNS, timeout, mid-body-transfer
	 * drop) are retried; a 403 never is — it means the request failed to identify itself, so retrying can only fail
	 * identically while burning rate budget.
	 */
	retry?: RetryOptions | boolean

	/**
	 * Time source powering the pacer, the cooldown timer, and the retry backoff. Defaults to {@linkcode systemClock};
	 * tests inject a fake clock so timing behavior is deterministic and instant.
	 */
	clock?: ClockLike

	/**
	 * Axios configuration.
	 */
	axios?: CreateAxiosDefaults
}

/**
 * A base class for API clients used in Mailwoman, providing request pacing, response caching, bounded retry, mapped
 * errors, and integrated logging.
 */
export class APIClient<C extends APIClientConfig = APIClientConfig> extends EventTarget implements AsyncDisposable {
	public readonly config: C

	#cooldownWithResolvers: PromiseWithResolvers<void> | null = null
	#requestInterval = 0
	#requestCountWithinCooldown = 0
	#lastRequestTime = 0

	readonly #clock: ClockLike
	readonly #pacer: RequestPacer | null
	readonly #retryPolicy: ResolvedRetryPolicy

	public get $cooldown(): Promise<void> {
		return this.#cooldownWithResolvers?.promise || Promise.resolve()
	}

	/**
	 * The prefixed logger for the API client.
	 */
	public readonly logger: IRuntimeLogger
	/**
	 * The Axios instance for the API client.
	 */
	public readonly axios: AxiosInstance | AxiosCacheInstance

	constructor(config: C) {
		super()

		this.config = config
		this.logger = ConsoleLogger.prefix(config.displayName)
		this.#clock = config.clock ?? systemClock
		this.#retryPolicy = resolveRetryPolicy(config.retry)
		this.#pacer = config.minRequestIntervalMs ? new RequestPacer(config.minRequestIntervalMs, this.#clock) : null

		const axiosInstance = Axios.create({
			...config.axios,
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

		this.#requestInterval = typeof config.requestsPerMinute === "number" ? MS_PER_MINUTE / config.requestsPerMinute : 0
		this.#lastRequestTime = this.#clock.now()
	}

	/**
	 * Perform a fetch operation using the API's Axios instance: paced, cooldown-gated, retried within the configured
	 * ceiling, and — on the final failure — mapped to a {@linkcode ResourceError} carrying a numeric `status` and a
	 * `(source, kind, reason)` URN.
	 *
	 * Error mapping happens HERE rather than in a response interceptor so the retry loop can see the raw `AxiosError`
	 * (status AND `Retry-After`) before it is summarized, and so every attempt re-enters the pacer/cooldown gates instead
	 * of a re-dispatch sneaking past them.
	 */
	public fetch = async <T>(options: AxiosRequestConfig): Promise<AxiosResponse<T>> => {
		const method = options.method?.toUpperCase() || "GET"

		for (let attempt = 1; ; attempt++) {
			await this.acquireDispatchSlot()

			this.logger.debug(`${method}: ${options.url}`)

			try {
				return await this.axios(options)
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
	 * Acquire permission to dispatch one request. Both gates reserve SYNCHRONOUSLY with respect to their own state, so
	 * concurrency cannot defeat either of them.
	 *
	 * The bug this replaced: `fetch()` awaited a single `$cooldown` read and the request was only COUNTED by a response
	 * interceptor. N callers invoked in the same turn all cleared the gate before any response came back to set a
	 * cooldown — measured at 40 dispatches inside 3ms against a configured budget of 2/minute, and 40 against 10/minute.
	 */
	protected acquireDispatchSlot = async (): Promise<void> => {
		await this.#pacer?.acquire()

		for (;;) {
			const pending = this.#cooldownWithResolvers

			if (!pending) {
				// Check AND reserve in the same synchronous step. Splitting them — "await the gate, then
				// count" — is the whole bug: every caller queued behind the same microtask turn passes a
				// gate that only closes once one of them has already counted, so the (N-1) callers behind
				// the budget-spending one sail straight through.
				this.#reserveCooldownSlot()

				return
			}

			await pending.promise

			// Clear the cooldown we observed, if it's still current — this is what terminates the loop
			// once the timer resolved without opening a replacement.
			if (this.#cooldownWithResolvers === pending) {
				this.#cooldownWithResolvers = null
			}
		}
	}

	/**
	 * Count this dispatch against the {@linkcode APIClientConfig.requestsPerMinute} budget, opening a cooldown once the
	 * budget is spent. Synchronous by construction: it must run to completion before the next caller can observe the
	 * counter, which is precisely what the response-interceptor version could not guarantee.
	 */
	#reserveCooldownSlot(): void {
		const { requestsPerMinute } = this.config

		if (!requestsPerMinute) return

		const now = this.#clock.now()
		const elapsed = now - this.#lastRequestTime

		this.#lastRequestTime = now

		this.#requestCountWithinCooldown++

		if (this.#requestCountWithinCooldown >= requestsPerMinute) {
			this.setCooldown(this.#requestInterval - elapsed)
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
