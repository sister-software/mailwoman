// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Tests whether a service answers by requesting one of its routes.
 */

/**
 * The milliseconds {@linkcode ReachabilityProbe.test} waits for a response
 * before it reports the service unreachable.
 */
export const DEFAULT_REACHABILITY_TIMEOUT_MS = 5000

/**
 * A probe that tests whether a service answers, by requesting a route on it.
 *
 * Probe the service the caller depends on, such as the geocoder API's `/health` route,
 * rather than a third party's connectivity endpoint.
 * A third-party endpoint reports whether the internet is reachable,
 * and the service can be down while it answers.
 *
 * Each probe of a third-party endpoint also sends the user's IP address to that party.
 *
 * The request runs in `cors` mode, so the status is readable.
 * A captive portal's interception of an HTTPS request fails the TLS handshake,
 * and the probe reports that as unreachable.
 */
export class ReachabilityProbe implements Disposable {
	#abortController: AbortController | null = null
	protected readonly url: string

	/**
	 * @param url The route to request.
	 * It must answer CORS requests from the page's origin.
	 */
	constructor(url: string | URL) {
		this.url = String(url)
	}

	public [Symbol.dispose] = (): void => this.abort()

	/**
	 * Cancels the test in flight.
	 * The cancelled test resolves `false`.
	 */
	public abort = (): void => {
		this.#abortController?.abort()
	}

	/**
	 * Resolves `true` when the route answers with a 2xx status, and `false` on any
	 * other status, a network failure or a timeout.
	 *
	 * A new test cancels the previous one.
	 */
	public test = (requestTimeout = DEFAULT_REACHABILITY_TIMEOUT_MS, requestInit?: RequestInit): Promise<boolean> => {
		this.abort()

		const controller = new AbortController()
		this.#abortController = controller

		return (
			// `AbortSignal.any` and `fetch` can throw synchronously, and the chain turns that into `false`.
			Promise.resolve()
				.then(() => {
					const signals = [controller.signal, AbortSignal.timeout(requestTimeout)]

					if (requestInit?.signal) {
						signals.push(requestInit.signal)
					}

					return fetch(this.url, {
						method: "GET",
						credentials: "omit",
						mode: "cors",
						cache: "no-store",
						...requestInit,
						signal: AbortSignal.any(signals),
					})
				})
				.then((response) => response.ok)
				.catch(() => false)
				.finally(() => {
					if (this.#abortController === controller) {
						this.#abortController = null
					}
				})
		)
	}
}
