/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fetch the browser runtime loads its artifacts through: a reset late in a download rejects the body read
 *   rather than the `fetch()` call, so the body is buffered inside the retry, and an http status is never retried
 *   because a 404 is an answer the loaders interpret.
 */

const ATTEMPTS = 3

const FIRST_RETRY_DELAY_MS = 500

/**
 * Only a `TypeError` marks a retriable network failure — a reset, a refused connection,
 * a cors refusal, or a body read that loses its connection — while an http status,
 * an abort, and a bad URL are not retried.
 */
function isNetworkFailure(error: unknown): boolean {
	return error instanceof TypeError
}

/**
 * One attempt, body included, so a connection lost mid-download is this attempt's failure to retry.
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
 * How much of a body has arrived: `total` is the response's declared length or `null`, and a retry
 * restarts `received` at zero because the lost attempt's bytes are gone and the transfer begins again.
 */
export type BytesReceived = (received: number, total: number | null) => void

/**
 * `content-length` describes the wire bytes while the reader yields decoded ones,
 * so a content-encoded response can report a fraction above 1; the consumer clamps
 * rather than this lying about the total.
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
 * `fetch` with the body already read, retried on a network failure; the same signature lets a loader
 * take it as its `fetchImpl` and read the response as bytes, text, or JSON exactly as a live one.
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
 * `fetchWithRetry` bound to a progress callback, as a plain `fetch` a loader can take
 * for its `fetchImpl`; `shouldReport` picks the request whose bytes are worth a bar,
 * since reporting every small artifact would make the bar jump backwards.
 */
export function fetchWithProgress(onBytes: BytesReceived, shouldReport: (url: string) => boolean): typeof fetch {
	return (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url

		return fetchWithRetry(input, init, shouldReport(url) ? onBytes : undefined)
	}
}
