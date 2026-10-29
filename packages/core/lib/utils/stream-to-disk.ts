/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stream one large file to disk through a `.part` rename, so an interrupted transfer can never present as a complete file.
 *
 *   Raw `fetch` is deliberate. `APIClient` serves small, repeated requests. A multi-hundred-megabyte stream does not fit that use.
 */

import type { PathBuilderLike } from "path-ts"

import { openWriteStream, pipeline, Readable } from "#fs/streams"
import { movePath, removePathIfPresent } from "#fs/writers"

const DEFAULT_PROGRESS_STRIDE_BYTES = 16 * 1024 * 1024

/**
 * The status a host answers a satisfied byte-range request with (RFC 9110 §15.3.7).
 */
const HTTP_PARTIAL_CONTENT = 206

export interface StreamToDiskOptions {
	url: string
	destination: PathBuilderLike
	context: string
	/**
	 * Extra request headers.
	 *
	 * The public data bucket's WAF refuses an unranged GET, so its consumer sends `range: bytes=0-`.
	 */
	headers?: Record<string, string>
	onProgress?: (message: string) => void
	/**
	 * Receives every chunk in order as it is written.
	 *
	 * A caller hashes the bytes in the same pass rather than reading a multi-gigabyte file back.
	 */
	onChunk?: (chunk: Uint8Array) => void
	/**
	 * Receives the OK response before its body is read.
	 *
	 * A caller records a header such as `Last-Modified`, which dates the bytes.
	 */
	onResponse?: (response: Response) => void
	progressStrideBytes?: number
	/**
	 * What this host's non-OK status means, appended to the refusal: the soil download service answers 400
	 * rather than 404 for a version date it does not hold, so a bare status would misdirect a reader.
	 */
	describeStatus?: (status: number) => string | undefined
	/**
	 * Where the bytes accumulate before the final rename.
	 * Defaults to `<destination>.part`.
	 */
	partialPath?: string
	/**
	 * The number of bytes already in {@link partialPath} to continue after.
	 *
	 * The request asks for `bytes=<resumeFrom>-` and appends the response.
	 * A response other than a 206 starting at that byte raises {@link ResumeRefusedError}
	 * and leaves the partial file as it was.
	 *
	 * The caller decides beforehand that the partial bytes belong to the same remote object.
	 */
	resumeFrom?: number
	/**
	 * Keep the partial file after a failed transfer so a later call can resume it.
	 * By default a failure removes it.
	 */
	retainPartial?: boolean
	/**
	 * Cancels the transfer.
	 */
	signal?: AbortSignal
}

/**
 * A host that answered a resumed request with something other than the requested byte range.
 */
export class ResumeRefusedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ResumeRefusedError"
	}
}

/**
 * Download one file to `destination`, returning its size: the bytes received plus any resumed offset.
 *
 * Follows redirects: a job endpoint that answers with a generated result URL routinely redirects again.
 * The downloader would write a redirect page to disk and report success if it stopped at the redirect.
 *
 * @throws {Error} When the response is not OK or contains no body.
 * A partial file is removed on any failure unless `retainPartial` is set.
 */
export async function streamToDisk(options: StreamToDiskOptions): Promise<number> {
	const partialPath = options.partialPath ?? `${options.destination}.part`
	const offset = options.resumeFrom ?? 0

	options.onProgress?.(offset ? `resuming ${options.url} at byte ${offset}` : `downloading ${options.url}`)

	const headers = { ...options.headers, ...(offset ? { range: `bytes=${offset}-` } : {}) }

	const response = await fetch(options.url, {
		redirect: "follow",
		...(Object.keys(headers).length ? { headers } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	})

	if (!response.ok || !response.body) {
		const explanation = options.describeStatus?.(response.status)

		throw new Error(`${options.context}: ${options.url} answered HTTP ${response.status}${explanation ?? ""}`)
	}

	if (offset) {
		const range = response.headers.get("content-range")
		const start = range ? /^bytes (\d+)-/u.exec(range)?.[1] : undefined

		// A host that ignores the range answers 200 with the whole object, and appending it would corrupt the file.
		if (response.status !== HTTP_PARTIAL_CONTENT || Number(start) !== offset) {
			await response.body.cancel()

			throw new ResumeRefusedError(
				`${options.context}: ${options.url} did not resume at byte ${offset} (HTTP ${response.status}, content-range ${range ?? "absent"})`
			)
		}
	}

	options.onResponse?.(response)

	const strideBytes = options.progressStrideBytes ?? DEFAULT_PROGRESS_STRIDE_BYTES

	let received = offset
	let reported = offset

	const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])

	source.on("data", (chunk: Buffer) => {
		received += chunk.byteLength
		options.onChunk?.(chunk)

		if (received - reported >= strideBytes) {
			reported = received

			options.onProgress?.(`${(received / 1024 / 1024).toFixed(0)} MB`)
		}
	})

	try {
		await pipeline(source, openWriteStream(partialPath, offset ? { flags: "a" } : undefined))
	} catch (error) {
		if (!options.retainPartial) {
			await removePathIfPresent(partialPath)
		}

		throw error
	}

	await movePath(partialPath, options.destination)

	options.onProgress?.(`downloaded ${received.toLocaleString()} bytes`)

	return received
}
