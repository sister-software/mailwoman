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
	#requestCountWithinCooldown = 0
	/**
	 * When the CURRENT budget window opened — the instant of its first dispatch, not of the last one. The cooldown is
	 * measured from here, which is what makes `requestsPerMinute` mean requests per MINUTE.
	 */
	#windowStartedAt = 0

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

		// THE PACING GATE LIVES IN THE ADAPTER, not in `fetch()`.
		//
		// `axios-cache-interceptor` short-circuits a cache HIT by replacing `config.adapter` with its own
		// `cachedAdapter`, so anything installed here is reached only when the request is actually going
		// to the network. Gating in `fetch()` instead put the cache interceptor DOWNSTREAM of the gate and
		// made every cache hit burn a full pacer sleep: measured 1 dispatch, 5 hits, five 111ms sleeps for
		// zero network traffic. `/Archives/` documents are cached for a century by design, so warm re-runs
		// are the EXPECTED mode for a bulk crawl — at 100k cached documents that is ~3 hours of sleeping
		// against an empty network. The client this replaced also paced only on a miss.
		//
		// Retries are unaffected: each attempt re-enters `this.axios(...)`, so each re-enters this adapter
		// and takes its own grant.
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
	 * Perform a fetch operation using the API's Axios instance: served from cache when possible, paced and cooldown-gated
	 * when not, retried within the configured ceiling, and — on the final failure — mapped to a {@linkcode ResourceError}
	 * carrying a numeric `status` and a `(source, kind, reason)` URN.
	 *
	 * Error mapping happens HERE rather than in a response interceptor so the retry loop can see the raw `AxiosError`
	 * (status AND `Retry-After`) before it is summarized. The pacing/cooldown gate deliberately does NOT happen here — it
	 * sits in the adapter (see the constructor), downstream of the cache, so a hit costs nothing. Every retry attempt
	 * re-enters `this.axios(...)` and therefore re-enters that gate; a retry burst cannot outrun the pacer.
	 */
	public fetch = async <T>(options: AxiosRequestConfig): Promise<AxiosResponse<T>> => {
		const method = options.method?.toUpperCase() || "GET"

		// A per-request `adapter` would WIN over the instance default in `mergeConfig`, and the pacing/cooldown gate
		// lives in that instance adapter — so passing one here would dispatch with no grant at all. Reproduced against
		// the un-stripped form: a client at `minRequestIntervalMs: 5000` issuing three concurrent `fetch({ url, adapter })`
		// calls made 3 dispatches, took 0 grants and slept 0 times.
		//
		// The cache interceptor swaps the adapter too, and that one is INTENDED — it is how a cache hit skips the gate
		// without spending a grant. The difference is that it swaps on the merged config from inside the interceptor
		// chain, after this method has already handed the request over. Stripping it here closes the caller-supplied
		// door without touching the interceptor's.
		//
		// Latent when found — no shipped client passes an adapter — which is exactly how the cooldown/pacer composition
		// bug survived too. Closing it before `bdc/sdk/client.ts` is written against this contract.
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
	 * Acquire permission to dispatch one request, clearing BOTH gates. Each reserves SYNCHRONOUSLY with respect to its
	 * own state, so concurrency cannot defeat either of them.
	 *
	 * The bug this replaced: `fetch()` awaited a single `$cooldown` read and the request was only COUNTED by a response
	 * interceptor. N callers invoked in the same turn all cleared the gate before any response came back to set a
	 * cooldown — measured at 40 dispatches inside 3ms against a configured budget of 2/minute, and 40 against 10/minute.
	 *
	 * The pacer is re-acquired on every pass of the loop, NOT taken once up front. A grant is a claim on a specific
	 * instant; blocking on a cooldown after taking one leaves it stale, and every caller holding a stale grant spends it
	 * the moment the cooldown lifts — measured as four pairs dispatching 0ms apart against a documented 100ms minimum
	 * when both gates were configured together. Re-acquiring discards the stale grant (the pacer under-issues by one per
	 * cooldown wait, which is the safe direction) and takes a fresh one for the instant we actually dispatch.
	 */
	protected acquireDispatchSlot = async (): Promise<void> => {
		for (;;) {
			await this.#pacer?.acquire()

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

		// The first dispatch after a reset OPENS the window. Everything below measures from that instant.
		if (this.#requestCountWithinCooldown === 0) {
			this.#windowStartedAt = now
		}

		this.#requestCountWithinCooldown++

		if (this.#requestCountWithinCooldown >= requestsPerMinute) {
			// Wait out the REMAINDER OF THE MINUTE, not `MS_PER_MINUTE / requestsPerMinute`.
			//
			// The original computed `(60000 / N) - elapsed`, which is the spacing between two requests, not the length
			// of the budget window — so N dispatches went out back to back and the client waited 60/N seconds before
			// releasing another N. Measured on a bare client at `requestsPerMinute: 10`, 20-call fan-out: arrivals
			// `[0 x10, 6000 x10]` — 20 inside one sliding minute against a budget of 10, a sustained 100/minute. A
			// caller trusting the docstring would have hammered an upstream at 10x its stated limit.
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
