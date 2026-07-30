/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file FCC Broadband Data Collection (BDC) public-API client.
 *
 *   Re-homed from Nexus's `sync/fcc/bdc/client.ts` (relicense-by-copy, no provenance headers):
 *   axios → global `fetch`, `ServiceRepository`/`APIClient` lifecycle → a plain factory function,
 *   `$private` from `@isp.nexus/sdk/runtime` → `@mailwoman/core/env`. The Nexus original's
 *   `$BCDClient` name was a transposed-letter typo ("BCD" for "BDC") — corrected here, and the
 *   service-symbol form itself is dropped in favor of the plain `createBDCClient` factory
 *   (2a decision 6).
 */

import { $private } from "@mailwoman/core/env"

/**
 * The FCC BDC public-API base URL every request is resolved against.
 */
export const BDC_API_BASE_URL = "https://broadbandmap.fcc.gov/api/public"

/**
 * Options for {@linkcode createBDCClient}.
 */
export interface CreateBDCClientOptions {
	/**
	 * FCC Broadband Map username. Defaults to `$private.FCC_MAP_USERNAME` when omitted.
	 */
	username?: string
	/**
	 * FCC Broadband Map API key, sent as the `hash_value` header. Defaults to `$private.FCC_MAP_API_KEY` when omitted.
	 */
	apiKey?: string
	/**
	 * Test seam — overrides the `fetch` implementation the client issues requests through. Defaults to
	 * `globalThis.fetch`. No test in this workspace ever performs a live network call; every test supplies a stub here.
	 */
	fetchImpl?: typeof fetch
}

/**
 * Query-string parameter values a {@linkcode BDCClient.get} call may carry. `undefined` values are omitted rather than
 * serialized as the literal string `"undefined"`.
 */
export type BDCQueryParams = Record<string, string | number | undefined>

/**
 * A constructed FCC BDC public-API client, as returned by {@linkcode createBDCClient}.
 */
export interface BDCClient {
	/**
	 * Issue an authenticated `GET` request against the BDC public API and parse the JSON response body.
	 *
	 * `path` is appended to {@linkcode BDC_API_BASE_URL} as-is (a leading slash, e.g. `/map/listAsOfDates`). `params`
	 * become the request's query string; the response body is returned UN-unwrapped — every BDC endpoint nests its
	 * payload under a `data` key (`{ data: [...] }`), so callers pluck `.data` themselves at the call site.
	 */
	get<T>(path: string, params?: BDCQueryParams): Promise<T>
}

/**
 * Create a FCC Broadband Data Collection public-API client.
 *
 * Auth: the BDC API takes a `username` + `hash_value` pair as plain request headers — read carefully off the Nexus
 * original's `axios.headers` config, this is NOT bearer/basic auth. Every request from {@linkcode BDCClient.get}
 * carries both headers. Throws a descriptive error when constructed without explicit credentials AND without the
 * `FCC_MAP_USERNAME`/`FCC_MAP_API_KEY` environment values — a silently-unauthenticated client would just 401 on first
 * use, which is a worse failure mode than failing fast at construction.
 */
export function createBDCClient(options: CreateBDCClientOptions = {}): BDCClient {
	const username = options.username ?? $private.FCC_MAP_USERNAME
	const apiKey = options.apiKey ?? $private.FCC_MAP_API_KEY
	const fetchImpl = options.fetchImpl ?? globalThis.fetch

	if (!username || !apiKey) {
		throw new Error(
			"createBDCClient: missing FCC Broadband Map credentials. Pass `username`/`apiKey` explicitly, or set the " +
				"`FCC_MAP_USERNAME`/`FCC_MAP_API_KEY` environment variables (register at https://broadbandmap.fcc.gov " +
				"to obtain them)."
		)
	}

	async function get<T>(path: string, params: BDCQueryParams = {}): Promise<T> {
		const url = new URL(`${BDC_API_BASE_URL}${path}`)

		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) {
				url.searchParams.set(key, String(value))
			}
		}

		const response = await fetchImpl(url, {
			headers: {
				username,
				hash_value: apiKey,
			},
		})

		if (!response.ok) {
			throw new Error(`BDC API request failed: ${response.status} ${response.statusText} (${url})`)
		}

		return (await response.json()) as T
	}

	return { get }
}
