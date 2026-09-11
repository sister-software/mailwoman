/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Retries and resumes interrupted corpus downloads.
 */

import { tryStat } from "@mailwoman/core/fs/readers"
import { openWriteStream, pipeline, Readable } from "@mailwoman/core/fs/streams"
import { movePath } from "@mailwoman/core/fs/writers"
import { sleep } from "@mailwoman/core/utils/sleep"

import { DEFAULT_RETRY_DELAY_MS, HTTPStatusError } from "#tools/fetch/download/network"

/**
 * The answer to a range that starts at or past the end of the body: the resume point is already the whole file.
 */
const HTTP_RANGE_NOT_SATISFIABLE = 416

/**
 * The answer to a satisfiable `Range` request; anything else means the host ignored the range and would send the whole
 * body again.
 */
const HTTP_PARTIAL_CONTENT = 206

/**
 * Run one transfer up to `1 + retries` times, pausing `retryDelayMs` between attempts. A government portal drops a
 * multi-hundred-megabyte connection often enough that a collection fetch which lets the first `TypeError: terminated`
 * propagate loses the whole run to one file; the per-file loop calls the transfer through this and records the failure
 * only once the attempts are spent. The last error is rethrown so the caller can name the file it lost.
 */
export async function withRetries<T>(
	transfer: () => Promise<T>,
	options: { retries?: number; retryDelayMs?: number; report?: (line: string) => void; label?: string } = {}
): Promise<T> {
	const { retries = 3, retryDelayMs = DEFAULT_RETRY_DELAY_MS, report, label = "transfer" } = options
	let lastError: unknown

	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt > 0) {
			report?.(`  retry ${attempt}/${retries} after ${retryDelayMs}ms — ${label}`)
			await sleep(retryDelayMs)
		}

		try {
			return await transfer()
		} catch (error) {
			lastError = error
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * The byte count already at `path`, or 0 when nothing is there — the resume point of an interrupted range download.
 */
async function bytesOnDisk(path: string): Promise<number> {
	const stat = await tryStat(path)

	return stat?.size ?? 0
}

/**
 * Download `url` to `dest` in ranges, resuming from whatever the `.tmp` sibling already holds. For a host that drops a
 * long connection every few megabytes but answers `Range` with 206 (the Korean address portal does both, measured at
 * 0.9–12 MB per connection against a 181 MB file), a whole-body transfer never finishes and a plain retry starts over;
 * this one asks for the remainder each time and keeps what landed. The total comes from the first `Content-Range`, and
 * the loop gives up after `maxConnections` connections so a host that keeps answering 206 with no bytes cannot spin.
 * Answers the byte count written; throws when the host answers anything but 206 for a range.
 */
export async function resumableDownload(options: {
	url: string
	dest: string
	headers?: Record<string, string>
	maxConnections?: number
	retryDelayMs?: number
	report?: (line: string) => void
}): Promise<number> {
	const { url, dest, headers = {}, maxConnections = 400, retryDelayMs = DEFAULT_RETRY_DELAY_MS, report } = options
	const tmp = dest + ".tmp"
	let have = await bytesOnDisk(tmp)
	let total: number | undefined

	for (let connection = 0; connection < maxConnections; connection++) {
		if (total !== undefined && have >= total) break

		let res: Response

		try {
			res = await fetch(url, { headers: { ...headers, range: `bytes=${have}-` }, signal: AbortSignal.timeout(600_000) })
		} catch {
			await sleep(retryDelayMs)

			continue
		}

		if (res.status === HTTP_RANGE_NOT_SATISFIABLE && have > 0) {
			// Nothing past `have`: the file on disk is already the whole body (a parallel filler or an earlier run
			// landed it), and `Content-Range: bytes */<total>` says how long it is.
			const whole = /\*\/(\d+)/.exec(res.headers.get("content-range") ?? "")?.[1]
			total = whole ? Number(whole) : have
			await res.body?.cancel()

			break
		}

		if (res.status !== HTTP_PARTIAL_CONTENT) {
			throw new HTTPStatusError(res.status, `HTTP ${res.status} for a range request — ${url}`)
		}

		const range = /bytes \d+-\d+\/(\d+)/.exec(res.headers.get("content-range") ?? "")?.[1]

		if (range) {
			total = Number(range)
		}

		const before = have

		try {
			// Append: the stream opens the file for appending so a partial body extends what earlier connections left.
			await pipeline(
				Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
				openWriteStream(tmp, { flags: "a" })
			)
		} catch {
			// The connection dropped mid-body; the bytes that landed are on disk, and the next range starts after them.
		}

		have = await bytesOnDisk(tmp)

		if (have === before) {
			await sleep(retryDelayMs)
		} else {
			report?.(`  ${(have / 1024 / 1024).toFixed(1)} MB${total ? ` of ${(total / 1024 / 1024).toFixed(1)} MB` : ""}`)
		}
	}

	if (total === undefined || have < total) {
		throw new Error(`resumable download stalled at ${have} of ${total ?? "?"} bytes — ${url}`)
	}

	await movePath(tmp, dest)

	return have
}

/**
 * The `Set-Cookie` values of a response folded into one `Cookie` header value, so a second request to the same portal
 * carries the session the first one opened.
 */
export function cookieHeader(res: Response): string {
	return res.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ")
}

/**
 * The file name a `Content-Disposition: attachment` header names, RFC 5987 form (`filename*=utf-8''…`) first, plain
 * `filename="…"` second, or `fallback` when the header carries neither.
 */
export function attachmentFilename(res: Response, fallback: string): string {
	const disposition = res.headers.get("content-disposition") ?? ""
	const extended = /filename\*=(?:utf-8|UTF-8)'[^']*'([^;]+)/.exec(disposition)?.[1]

	if (extended) return decodeURIComponent(extended.trim())
	const plain = /filename="?([^";]+)"?/.exec(disposition)?.[1]

	if (plain) return decodeURIComponent(plain.trim())

	return fallback
}
