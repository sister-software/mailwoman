/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Request-body limits for the Workers. A Worker reads a body in chunks and stops at its limit, so a client that
 *   sends more than the limit costs the Worker the limit and no more.
 */

/**
 * The largest request body the API Worker forwards, in bytes.
 *
 * A native geocode or parse request is one address and a few options, well under a kilobyte.
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024

/**
 * Reads `request`'s body into one buffer, or answers null once it passes `maxBytes`.
 *
 * A request without a body reads as an empty buffer.
 */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<ArrayBuffer | null> {
	const reader = request.body?.getReader()

	if (!reader) return new ArrayBuffer(0)

	const chunks: Uint8Array[] = []
	let length = 0

	while (true) {
		const { done, value } = await reader.read()

		if (done) break

		length += value.byteLength

		if (length > maxBytes) {
			await reader.cancel()

			return null
		}

		chunks.push(value)
	}

	const bytes = new Uint8Array(length)
	let offset = 0

	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}

	return bytes.buffer
}
