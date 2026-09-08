/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fetch the browser runtime loads its artifacts through. The data origin resets a long download now and then
 *   (measured: 1 of 18 cold loads lost the 38 MB model to `net::ERR_CONNECTION_RESET` 4.9 s in, and 2 of 16 loads
 *   failed under a two-attempt retry that covered the connection alone), and a reset that far in rejects the BODY
 *   read, not the `fetch()` call. So the body is buffered here, inside the retry, and the loader receives a response
 *   whose bytes are already complete. An HTTP status is never retried: a 404 is an answer, and the loaders decide what
 *   an absent artifact means.
 */

/**
 * The number of attempts a network failure gets, the first included.
 */
const ATTEMPTS = 3

/**
 * The pause before the second attempt; each later attempt doubles it.
 */
const FIRST_RETRY_DELAY_MS = 500

/**
 * `fetch` rejects with a `TypeError` for a network failure (a reset, a refused connection, a CORS refusal) and never
 * for an HTTP status; a body read that loses its connection rejects the same way. Anything else (an abort, a bad URL)
 * is not retried.
 */
function isNetworkFailure(error: unknown): boolean {
	return error instanceof TypeError
}

/**
 * One attempt: the request, and for a successful status the whole body, so a connection lost mid-download is this
 * attempt's failure and not the caller's.
 */
async function fetchComplete(
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1]
): Promise<Response> {
	const response = await fetch(input, init)

	if (!response.ok || !response.body) return response

	return new Response(await response.arrayBuffer(), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}

function pause(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
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
 * `fetch` with the body already read, retried on a network failure. Same signature, so a loader takes it as its
 * `fetchImpl`; the response it answers with can be read as bytes, text or JSON exactly as a live one.
 */
export async function fetchWithRetry(
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1]
): Promise<Response> {
	let attempt = 1

	for (;;) {
		try {
			return await fetchComplete(input, init)
		} catch (error) {
			if (attempt >= ATTEMPTS || !isNetworkFailure(error) || init?.signal?.aborted) throw error

			await pause(FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1), init?.signal)

			attempt++
		}
	}
}
