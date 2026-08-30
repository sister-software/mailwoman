/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stream one large file to disk through a `.part` rename — the shape every layer acquisition uses, and the
 *   one thing about it that is a correctness rule rather than a convenience.
 *
 *   THIS IS A FILE TRANSFER, NOT AN API REQUEST, AND IT IS RAW `fetch` ON PURPOSE. The repo's rule sends HTTP
 *   clients through `@mailwoman/core/api`'s `APIClient`, and the rule draws its line at what that class is
 *   for: pacing, bounded retry, response caching and error mapping over small bodies and repeated calls. None
 *   of it applies to a multi-hundred-megabyte archive. Caching one through a JSON-validating disk cache would
 *   write a second, unreadable copy of a file already on disk; there is nothing to pace, because a transfer
 *   like this runs once per product vintage; and axios buffers any non-stream response type in memory. The
 *   METADATA reads around such a transfer DO go through `APIClient`, and each caller's client module says so.
 *
 *   THE `.part` RENAME IS THE RULE. An interrupted transfer must never present as a complete file: the next
 *   run would find it, skip the download and ingest a truncated archive, which reads as a smaller source
 *   rather than as a failure. The rename is atomic within a filesystem, so a file at the final path is a file
 *   that finished.
 *
 *   SHARED BY EVERY LAYER ACQUISITION rather than copied into each, because it is stream plumbing that knows
 *   nothing about any product. What stays with each caller is where the URL came from, what the cache is keyed
 *   on, and what to do with the bytes afterwards.
 */

import { Readable } from "@mailwoman/platform/stream"
import { pipeline } from "@mailwoman/platform/stream/promises"

import { openWriteStream } from "#fs/streams"
import { movePath, removePathIfPresent } from "#fs/writers"

/**
 * Bytes between progress reports, where the caller states no preference.
 */
const DEFAULT_PROGRESS_STRIDE_BYTES = 16 * 1024 * 1024

export interface StreamToDiskOptions {
	url: string
	/**
	 * Where the finished file lands. The transfer writes to `${destination}.part` and renames on a clean finish.
	 */
	destination: string
	/**
	 * Names the caller in the refusal, so a log says which acquisition stopped.
	 */
	context: string
	onProgress?: (message: string) => void
	/**
	 * Bytes between progress reports. Scale it to the transfer: the default suits a several-hundred-megabyte archive, and
	 * leaves a 13 MB one reporting once.
	 */
	progressStrideBytes?: number
	/**
	 * What this host's non-OK status MEANS, appended to the refusal.
	 *
	 * A status code is a poor diagnosis on a host that reuses one. The soil download service answers 400 rather than 404
	 * for a version date it does not hold, so the bare status sends a reader looking for a malformed request instead of a
	 * stale catalogue date. Return `undefined` for a status the caller has nothing to add about.
	 */
	describeStatus?: (status: number) => string | undefined
}

/**
 * Download one file to `destination`, returning the bytes received.
 *
 * Redirects are followed: a job endpoint that answers with a generated result URL routinely redirects again, and a
 * transfer that stopped at the redirect would write a redirect page to disk and report success.
 *
 * @throws {Error} When the response is not OK, or carries no body. A partial file is removed on any failure.
 */
export async function streamToDisk(options: StreamToDiskOptions): Promise<number> {
	const partialPath = `${options.destination}.part`

	options.onProgress?.(`downloading ${options.url}`)

	const response = await fetch(options.url, { redirect: "follow" })

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
