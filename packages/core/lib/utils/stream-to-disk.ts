/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stream one large file to disk through a `.part` rename, so an interrupted transfer can never present as a complete file.
 *
 *   Raw `fetch` is deliberate: `APIClient` serves small, repeated requests, and a multi-hundred-megabyte stream is none of those.
 */

import type { PathBuilderLike } from "path-ts"

import { openWriteStream, pipeline, Readable } from "#fs/streams"
import { movePath, removePathIfPresent } from "#fs/writers"

const DEFAULT_PROGRESS_STRIDE_BYTES = 16 * 1024 * 1024

export interface StreamToDiskOptions {
	url: string
	destination: PathBuilderLike
	context: string
	/**
	 * Extra request headers; the public data bucket's WAF refuses an unranged GET,
	 * so its consumer sends `range: bytes=0-`.
	 */
	headers?: Record<string, string>
	onProgress?: (message: string) => void
	progressStrideBytes?: number
	/**
	 * What this host's non-OK status means, appended to the refusal: the soil download service answers 400
	 * rather than 404 for a version date it does not hold, so a bare status would misdirect a reader.
	 */
	describeStatus?: (status: number) => string | undefined
}

/**
 * Download one file to `destination`, returning the bytes received.
 *
 * Follows redirects: a job endpoint that answers with a generated result URL routinely redirects
 * again, and stopping at the redirect would write a redirect page to disk and report success.
 *
 * @throws {Error} When the response is not OK or carries no body; a partial file is removed on any failure.
 */
export async function streamToDisk(options: StreamToDiskOptions): Promise<number> {
	const partialPath = `${options.destination}.part`

	options.onProgress?.(`downloading ${options.url}`)

	const response = await fetch(options.url, {
		redirect: "follow",
		...(options.headers ? { headers: options.headers } : {}),
	})

	if (!response.ok || !response.body) {
		const explanation = options.describeStatus?.(response.status)

		throw new Error(
			`${options.context}: ${options.url} answered HTTP ${response.status}${explanation === undefined ? "" : explanation}`
		)
	}

	const strideBytes = options.progressStrideBytes ?? DEFAULT_PROGRESS_STRIDE_BYTES

	let received = 0
	let reported = 0

	const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])

	source.on("data", (chunk: Buffer) => {
		received += chunk.byteLength

		if (received - reported >= strideBytes) {
			reported = received

			options.onProgress?.(`${(received / 1024 / 1024).toFixed(0)} MB`)
		}
	})

	try {
		await pipeline(source, openWriteStream(partialPath))
	} catch (error) {
		await removePathIfPresent(partialPath)

		throw error
	}

	await movePath(partialPath, options.destination)

	options.onProgress?.(`downloaded ${received.toLocaleString()} bytes`)

	return received
}
