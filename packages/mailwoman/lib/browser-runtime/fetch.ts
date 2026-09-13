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
	init?: Parameters<typeof fetch>[1],
	onBytes?: BytesReceived
): Promise<Response> {
	const response = await fetch(input, init)

	if (!response.ok || !response.body) return response

	const bytes = onBytes ? await drainWithProgress(response, onBytes) : new Uint8Array(await response.arrayBuffer())

	return new Response(bytes, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}

/**
 * How much of a body has arrived. `total` is what the response declares, or `null` when it declares nothing.
 *
 * A retry restarts the count at zero, which is the truth: the bytes from the lost attempt are gone and the transfer
 * begins again.
 */
export type BytesReceived = (received: number, total: number | null) => void

/**
 * Read a body chunk by chunk, reporting progress, and answer the bytes.
 *
 * This is what the plain `arrayBuffer()` path cannot do: it resolves once, at the end, so a 38 MB transfer produces no
 * signal until it is over. Buffering still happens — the retry above needs a complete body — but the caller learns how
 * far along it is while it happens.
 *
 * `content-length` describes the bytes ON THE WIRE while the reader yields decoded ones, so a content-encoded response
 * can report a fraction above 1. The consumer clamps rather than this lying about the total it was given.
 */
async function drainWithProgress(response: Response, onBytes: BytesReceived): Promise<Uint8Array> {
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
	init?: Parameters<typeof fetch>[1],
	onBytes?: BytesReceived
): Promise<Response> {
	let attempt = 1

	for (;;) {
		try {
			return await fetchComplete(input, init, onBytes)
		} catch (error) {
			if (attempt >= ATTEMPTS || !isNetworkFailure(error) || init?.signal?.aborted) throw error

			await pause(FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1), init?.signal)

			attempt++
		}
	}
}

/**
 * `fetchWithRetry` bound to a progress callback, as a plain `fetch` a loader can take for its `fetchImpl`.
 *
 * A loader is handed one `fetchImpl` and uses it for every artifact, so `shouldReport` decides which request's bytes
 * are worth a bar — the model is 38 MB and the lexicons are kilobytes, and reporting all of them would make the bar
 * jump backwards as each small one starts.
 */
export function fetchWithProgress(onBytes: BytesReceived, shouldReport: (url: string) => boolean): typeof fetch {
	return (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url

		return fetchWithRetry(input, init, shouldReport(url) ? onBytes : undefined)
	}
}
