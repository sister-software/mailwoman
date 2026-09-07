/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fetch the browser runtime loads its artifacts through. The data origin resets a long download now and then
 *   (measured: 1 of 18 cold loads lost the 38 MB model to `net::ERR_CONNECTION_RESET` after 4.9 s), and a fetch that
 *   rejects for a network reason is retried once before the failure reaches the loader. An HTTP status is never
 *   retried: a 404 is an answer, and the loaders decide what an absent artifact means.
 */

/**
 * The number of attempts a network failure gets, the first included.
 */
const ATTEMPTS = 2

/**
 * `fetch` rejects with a `TypeError` for a network failure (a reset, a refused connection, a CORS refusal) and never
 * for an HTTP status; anything else (an abort, a bad URL) is not retried.
 */
function isNetworkFailure(error: unknown): boolean {
	return error instanceof TypeError
}

/**
 * `fetch`, with one retry on a network failure. Same signature, so a loader takes it as its `fetchImpl`.
 */
export async function fetchWithRetry(
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1]
): Promise<Response> {
	let attempt = 1

	for (;;) {
		try {
			return await fetch(input, init)
		} catch (error) {
			if (attempt >= ATTEMPTS || !isNetworkFailure(error) || init?.signal?.aborted) throw error

			attempt++
		}
	}
}
