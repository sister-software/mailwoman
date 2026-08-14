/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A scripted stub Axios ADAPTER for testing {@linkcode APIClient} subclasses, and the
 *   Axios-shaped error builder it rejects with. The sibling of `./test-clocks.ts`: that module makes
 *   time deterministic, this one makes the network deterministic, and a pacing test needs both.
 *
 *   Extracted from `filer/sdk/sec-client.test.ts` and `bdc/sdk/client.test.ts`, which had grown
 *   near-identical copies of it. That is the expected shape of the duplication rather than a
 *   surprise: `AGENTS.md` names those two as the worked examples for the `APIClient` migration, so
 *   the second client's tests were written from the first's, and every client migrated after them
 *   would have copied it again.
 *
 *   Everything here is built STRUCTURALLY — `isAxiosError: true` plus `config`/`code`/`response`,
 *   and the adapter typed through `APIClientConfig["axios"]` — because the packages under test
 *   depend on neither `axios` nor `axios-cache-interceptor`, reaching both only through
 *   `@mailwoman/core`. A test file is not a reason to breach that, so this module does not import
 *   axios either.
 */

import type { APIClientConfig } from "./APIClient.ts"

const HTTP_OK = 200
const HTTP_MULTIPLE_CHOICES = 300
const HTTP_SERVER_ERROR_MIN = 500

/**
 * The interesting subset of an Axios request config, as a stub adapter sees it.
 */
export interface StubRequestConfig {
	url?: string
	headers?: Record<string, unknown>
	timeout?: number
	/**
	 * Set by a binary request path (`"arraybuffer"`). Absent on a JSON client's calls.
	 */
	responseType?: string
	/**
	 * The per-request `axios-cache-interceptor` override — `false` is how a caller turns caching off for one call without
	 * touching `core/api`.
	 */
	cache?: unknown
}

/**
 * One scripted adapter outcome.
 */
export interface StubOutcome {
	status?: number
	statusText?: string
	/**
	 * The RAW body, as the transport would hand it to Axios's `transformResponse`. A string here is what an upstream
	 * serving HTML under a 200 actually looks like; a `Buffer` is what Axios's Node adapter produces for `responseType:
	 * "arraybuffer"`. Anything else is JSON-serialized the way a JSON endpoint would.
	 */
	body?: unknown
	headers?: Record<string, string>
	/**
	 * A transport-level failure — no HTTP response ever arrives. `code` picks the class: `ERR_NETWORK` for a dropped
	 * socket, `ECONNABORTED` for this attempt's own timeout firing.
	 */
	throws?: { message: string; code: string }
}

/**
 * The Axios overrides an {@linkcode APIClient} accepts, reached through `APIClientConfig` rather than by importing
 * `axios`.
 */
export type AxiosOverrides = NonNullable<APIClientConfig["axios"]>

export interface StubTransport {
	/**
	 * Spread into the client factory as its `axios` override.
	 */
	axios: AxiosOverrides
	/**
	 * Every dispatched URL, in order.
	 */
	calls: string[]
	/**
	 * Every dispatched request config, in order — headers, timeout, responseType, per-request cache override.
	 */
	configs: StubRequestConfig[]
	/**
	 * `clock.now()` at each dispatch, when a clock was supplied. The pacing assertions read this.
	 */
	dispatchTimes: number[]
}

export interface StubTransportOptions {
	/**
	 * Records a timestamp into {@linkcode StubTransport.dispatchTimes} on every dispatch. Omit when timing is not under
	 * test.
	 */
	clock?: { now(): number }
	/**
	 * The body served when an outcome names none. Defaults to `{ ok: true }`; pass the envelope the client under test
	 * expects when it validates one (BDC's `{ data: [] }`, say).
	 */
	defaultBody?: unknown
}

/**
 * Build an Axios-shaped rejection without importing `axios`. `isAxiosError(payload)` is `isObject(payload) &&
 * payload.isAxiosError === true`, and everything downstream reads `config`, `code`, and `response` — so this is the
 * full contract that matters.
 */
export function axiosLikeError(message: string, code: string, config: StubRequestConfig, response?: unknown): Error {
	const error = new Error(message) as Error & Record<string, unknown>

	error.isAxiosError = true
	error.code = code
	error.config = config

	if (response) {
		error.response = response
	}

	return error
}

/**
 * A stub Axios adapter that replays `outcomes` (holding on the last entry once exhausted) and records every dispatch.
 *
 * It reproduces what Axios's real adapters do on a failing status — reject with an Axios-shaped error CARRYING the
 * response — because `validateStatus` is applied by the adapter, not by the interceptor chain. A test that resolves
 * with a 4xx instead would exercise a path the real transport never takes.
 */
export function stubTransport(outcomes: StubOutcome[], options: StubTransportOptions = {}): StubTransport {
	const { clock, defaultBody = { ok: true } } = options
	const calls: string[] = []
	const configs: StubRequestConfig[] = []
	const dispatchTimes: number[] = []
	let index = 0

	const adapter = async (config: StubRequestConfig): Promise<unknown> => {
		calls.push(String(config.url))
		configs.push(config)

		if (clock) {
			dispatchTimes.push(clock.now())
		}

		const outcome = outcomes[Math.min(index, outcomes.length - 1)]!

		index++

		if (outcome.throws) {
			throw axiosLikeError(outcome.throws.message, outcome.throws.code, config)
		}

		const status = outcome.status ?? HTTP_OK

		const response = {
			// Axios's `transformResponse` runs on the RAW body, so hand it exactly what the wire would: a
			// string passes through untouched (that is how an HTML error page under a 200 actually arrives),
			// bytes pass through untouched, and anything else is serialized the way a JSON endpoint would.
			data:
				typeof outcome.body === "string" || Buffer.isBuffer(outcome.body)
					? outcome.body
					: JSON.stringify(outcome.body ?? defaultBody),
			status,
			statusText: outcome.statusText ?? "OK",
			headers: outcome.headers ?? {},
			config,
		}

		if (status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES) return response

		throw axiosLikeError(
			`Request failed with status code ${status}`,
			status >= HTTP_SERVER_ERROR_MIN ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST",
			config,
			response
		)
	}

	// Structurally an Axios adapter. The precise `AxiosAdapter` signature isn't nameable here without
	// importing `axios`, which the packages under test deliberately do not depend on.
	return { axios: { adapter } as AxiosOverrides, calls, configs, dispatchTimes }
}
