// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The fetch the browser runtime loads its artifacts through: a reset late in a download rejects
 *   the body read rather than the `fetch()` call, so the body is buffered inside the retry.
 *
 *   An HTTP status is never retried because a 404 is an answer the loaders interpret.
 *   An attempt that receives no bytes for `STALL_TIMEOUT_MS` is aborted and retried,
 *   because a connection that goes silent without closing never rejects on its own.
 */

import { startEarly } from "@mailwoman/core/promises"

const ATTEMPTS = 3

const FIRST_RETRY_DELAY_MS = 500

/**
 * How long one attempt may wait for its response headers or its next body chunk.
 *
 * The timer measures silence rather than total duration.
 * A slow download that keeps delivering bytes runs to completion.
 */
export const STALL_TIMEOUT_MS = 30_000

/**
 * An attempt aborted because its connection delivered no bytes for {@link STALL_TIMEOUT_MS}.
 */
export class FetchStalledError extends Error {
	constructor(url: string, timeoutMs: number) {
		super(`fetch stalled: no bytes from ${url} for ${timeoutMs} ms`)
		this.name = "FetchStalledError"
	}
}

/**
 * A `TypeError` marks a retriable network failure.
 *
 * A reset, a refused connection, a CORS refusal and a lost body read each raise one.
 * A stalled attempt is retried the same way.
 *
 * An HTTP status, a caller's abort and a bad URL are not retried.
 */
function isNetworkFailure(error: unknown): boolean {
	return error instanceof TypeError || error instanceof FetchStalledError
}

/**
 * One attempt, body included, so a connection lost mid-download is this attempt's failure to retry.
 */
async function fetchComplete(
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
	onBytes?: BytesReceived
): Promise<Response> {
	const stall = new AbortController()
	const signal = init?.signal ? AbortSignal.any([init.signal, stall.signal]) : stall.signal
	let timer: ReturnType<typeof setTimeout> | undefined

	const rearm = (): void => {
		clearTimeout(timer)
		timer = setTimeout(() => stall.abort(new FetchStalledError(requestURL(input), STALL_TIMEOUT_MS)), STALL_TIMEOUT_MS)
	}

	rearm()

	try {
		const response = await fetch(input, { ...init, signal })

		if (!response.ok || !response.body) return response

		rearm()

		const bytes = await drain(response, (received, total) => {
			rearm()
			onBytes?.(received, total)
		})

		return new Response(bytes, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		})
	} catch (error) {
		// A browser rejects an aborted read with the abort reason, but the platform doesn't guarantee it.
		throw stall.signal.aborted ? stall.signal.reason : error
	} finally {
		clearTimeout(timer)
	}
}

/**
 * How much of a body has arrived.
 *
 * `total` is the response's declared length or `null`.
 * A retry restarts `received` at zero because the lost attempt's bytes are gone
 * and the transfer begins again.
 */
export type BytesReceived = (received: number, total: number | null) => void

/**
 * Reads a response body chunk by chunk, reporting each arrival.
 *
 * `content-length` describes the wire bytes while the reader yields decoded ones,
 * so a content-encoded response can report a fraction above 1.
 * The consumer clamps rather than this lying about the total.
 */
async function drain(response: Response, onBytes: BytesReceived): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length"))
	const total = Number.isFinite(declared) && declared > 0 ? declared : null
	const reader = response.body!.getReader()
	const chunks: Uint8Array[] = []
	let received = 0

	onBytes(0, total)

	for (;;) {
		const { done, value } = await reader.read()

		if (done) break

		if (!value) continue

		chunks.push(value)
		received += value.byteLength
		onBytes(received, total)
	}

	const bytes = new Uint8Array(received)
	let offset = 0

	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}

	return bytes
}

function pause(ms: number, signal: AbortSignal | null): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}, ms)

		function onAbort(): void {
			clearTimeout(timer)
			reject(signal?.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError"))
		}

		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

/**
 * The request options of a retry: the caller's, in `reload` cache mode unless the caller chose `no-store`.
 *
 * A failed attempt may have read a short body from the browser's HTTP cache,
 * and `reload` makes the retry fetch from the network and refresh that entry.
 * A caching service worker reads the same mode as a request to pass its stored copy.
 */
function retryInit(init?: Parameters<typeof fetch>[1]): RequestInit {
	return { ...init, cache: init?.cache === "no-store" ? "no-store" : "reload" }
}

/**
 * `fetch` with the body already read, retried on a network failure.
 *
 * The same signature lets a loader take it as its `fetchImpl` and read the response
 * as bytes, text, or JSON exactly as a live one.
 *
 * Each retry runs in the cache mode {@linkcode retryInit} chooses.
 */
export async function fetchWithRetry(
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
	onBytes?: BytesReceived
): Promise<Response> {
	let attempt = 1

	for (;;) {
		try {
			return await fetchComplete(input, attempt === 1 ? init : retryInit(init), onBytes)
		} catch (error) {
			if (attempt >= ATTEMPTS || !isNetworkFailure(error) || init?.signal?.aborted) throw error

			await pause(FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1), init?.signal ?? null)

			attempt++
		}
	}
}

/**
 * `fetchWithRetry` bound to a progress callback, as a plain `fetch` a loader can take
 * for its `fetchImpl`; `shouldReport` picks the request whose bytes the bar reports,
 * since reporting every small artifact would make the bar jump backwards.
 */
export function fetchWithProgress(onBytes: BytesReceived, shouldReport: (url: string) => boolean): typeof fetch {
	return (input, init) => {
		const url = requestURL(input)

		return fetchWithRetry(input, init, shouldReport(url) ? onBytes : undefined)
	}
}

function requestURL(input: Parameters<typeof fetch>[0]): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

/**
 * Start a GET for each of `urls` through `fetchImpl` now.
 *
 * The returned `fetch` answers the first request for each URL with its started response.
 * Any other request goes to `fetchImpl` unchanged, a repeat request included.
 *
 * A failed prefetch rejects, with its own error, at the request that reads it.
 * It isn't unhandled before then.
 */
export function prefetchingFetch(fetchImpl: typeof fetch, urls: readonly string[]): typeof fetch {
	const started = new Map<string, Promise<Response>>()

	for (const url of urls) {
		started.set(url, startEarly(fetchImpl(url)))
	}

	return (input, init) => {
		const url = requestURL(input)
		const response = init ? undefined : started.get(url)

		if (!response) return fetchImpl(input, init)

		started.delete(url)

		return response
	}
}
