/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Download and manifest utilities for `mailwoman corpus fetch <source>`.
 */

import { pathExists, readLocalTextFile, tryStat } from "@mailwoman/core/fs/readers"
import { openWriteStream, pipeline, Readable } from "@mailwoman/core/fs/streams"
import { movePath, writeLocalFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { tryParsingJSON } from "@mailwoman/core/json"
import { sleep } from "@mailwoman/core/utils/sleep"
import type { PathBuilderLike } from "path-ts"

/**
 * Rate limited — retryable, the server is asking us to back off.
 */
const HTTP_TOO_MANY_REQUESTS = 429

/**
 * The answer to a satisfiable `Range` request; anything else means the host ignored the range and would send the whole
 * body again.
 */
const HTTP_PARTIAL_CONTENT = 206

/**
 * Lowest 5xx status. Server-side failures are retryable; 4xx are not.
 */
const HTTP_SERVER_ERROR_MIN = 500

/**
 * Highest 5xx status.
 */
const HTTP_SERVER_ERROR_MAX = 599

/**
 * The option base every `mailwoman corpus fetch <source>` module extends.
 */
/**
 * How long a failed transfer waits before the next attempt.
 */
export const DEFAULT_RETRY_DELAY_MS = 5000

export interface BaseFetchOptions {
	/**
	 * Destination root for downloaded source data. Each source writes its own subdirectory.
	 */
	outRoot: PathBuilderLike
	/**
	 * Pause between transfer retries, in milliseconds. Defaults to {@linkcode DEFAULT_RETRY_DELAY_MS}.
	 *
	 * A test that exercises the failure path pays this delay once per retry in real time — measured at 20.1 s for the two
	 * failing-transfer cases in `geonames-postal.test.ts`, which is the whole cost of that file. The retry COUNT is the
	 * behaviour under test there; the pause between attempts is not, so it is a caller's to shorten.
	 */
	retryDelayMs?: number
}

/**
 * The per-run result every fetch module returns; the command maps `failed > 0` to exit code 1.
 */
export interface FetchSummary {
	fetched: number
	skipped: number
	failed: number
	failedCodes: string[]
}

/**
 * The sibling `MANIFEST.json` shape the single-file fetch modules write: origin URL + fetch timestamp + byte count +
 * sha256, so downstream adapters can verify provenance.
 */
export interface SourceManifest {
	source_url: string
	downloaded_at: string
	filename: string
	sha256: string
	bytes: number
}

/**
 * A status worth retrying: rate limiting or a server-side failure.
 */
/**
 * An HTTP failure that CARRIES its status, so callers branch on `error.status` rather than on message prose. The prose
 * route shipped a real flake: a caller classified "not published upstream" with `message.includes("404")`, and the
 * message contains the URL — an ephemeral test-server port such as `:40453` satisfies it while the actual status is 500.
 * Roughly 1–2% of ephemeral ports contain the substring, which is exactly the kind of sometimes-failure that burns a CI
 * run and vanishes locally.
 */
export class HTTPStatusError extends Error {
	readonly status: number

	constructor(status: number, message: string) {
		super(message)
		this.name = "HTTPStatusError"
		this.status = status
	}
}

export function isTransientStatus(status: number): boolean {
	return status === HTTP_TOO_MANY_REQUESTS || (status >= HTTP_SERVER_ERROR_MIN && status <= HTTP_SERVER_ERROR_MAX)
}

export interface DownloadOptions {
	url: string
	dest: string
	/**
	 * Per-attempt timeout. Default 10 minutes — these are multi-GB government dumps.
	 */
	timeoutMs?: number
	/**
	 * Extra attempts after the first, taken only on transient statuses or network errors. Default 0.
	 */
	retries?: number
	/**
	 * Delay between attempts. Default 5s.
	 */
	retryDelayMs?: number
	headers?: Record<string, string>
	report?: (line: string) => void
}

/**
 * Download `url` to `dest` with per-attempt timeout and transient-status retry. Throws on a non-transient HTTP status
 * or once retries are exhausted. Returns the byte count written.
 */
export async function downloadToFile(options: DownloadOptions): Promise<{ bytes: number }> {
	const {
		url,
		dest,
		timeoutMs = 600_000,
		retries = 0,
		retryDelayMs = DEFAULT_RETRY_DELAY_MS,
		headers,
		report,
	} = options

	let lastError: unknown

	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt > 0) {
			report?.(`retry ${attempt}/${retries} after ${retryDelayMs}ms — ${url}`)
			await sleep(retryDelayMs)
		}

		let res: Response

		try {
			// Raw `fetch`, deliberately: this is the shared FILE downloader and the body is piped to disk below.
			// `APIClient` is the repo default for API requests — small bodies, repeated calls — and buffers a
			// non-stream response in memory, which is the one thing a multi-gigabyte transfer must not do.
			res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
		} catch (error) {
			// AbortSignal timeouts and network-level failures are retryable.
			lastError = error

			continue
		}

		if (!res.ok) {
			const error = new HTTPStatusError(res.status, `HTTP ${res.status} ${res.statusText} — ${url}`)

			if (!isTransientStatus(res.status)) throw error
			lastError = error

			continue
		}

		try {
			const buffer = Buffer.from(await res.arrayBuffer())
			await writeLocalFile(buffer, dest)

			return { bytes: buffer.byteLength }
		} catch (error) {
			// A mid-stream abort while reading the body is retryable too.
			lastError = error
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export interface StreamDownloadOptions {
	headers?: Record<string, string>
	timeoutMs: number
	retries: number
	retryDelayMs: number
}

/**
 * Stream an HTTP download to disk, returning the final HTTP status (0 on network error after retries). Follows
 * redirects (the Census and OpenAddresses endpoints both 302 to their real hosts).
 *
 * Kept separate from {@link downloadToFile} on purpose: this one streams a multi-GB body to disk (the buffered helper
 * reads via `arrayBuffer()`) and returns the HTTP status instead of throwing, which the per-file result collectors and
 * two-URL fallback ladders consume.
 */
export async function streamDownload(url: string, dest: string, opts: StreamDownloadOptions): Promise<number> {
	for (let attempt = 0; attempt <= opts.retries; attempt++) {
		try {
			const res = await fetch(url, {
				headers: opts.headers ?? {},
				redirect: "follow",
				signal: AbortSignal.timeout(opts.timeoutMs),
			})

			if (res.ok && res.body) {
				await pipeline(Readable.fromWeb(res.body), openWriteStream(dest))

				return res.status
			}

			if (attempt < opts.retries && isTransientStatus(res.status)) {
				await sleep(opts.retryDelayMs)

				continue
			}

			return res.status
		} catch {
			if (attempt < opts.retries) {
				await sleep(opts.retryDelayMs)

				continue
			}

			return 0
		}
	}

	return 0
}

/**
 * Read a MANIFEST.json; `null` when missing or corrupt (callers re-fetch from scratch).
 */
export async function readManifest<T>(path: string): Promise<T | null> {
	if (!(await pathExists(path))) return null

	// A read failure (e.g. the file vanished after the existsSync probe) maps to null like corrupt
	// JSON does; tryParsingJSON returns null for the non-string sentinel.
	const text = await readLocalTextFile(path).catch(() => null)

	return tryParsingJSON<T>(text)
}

/**
 * Load manifest entries into a map so untouched keys survive a partial re-fetch.
 */
export async function loadManifestEntries<T>(path: string, key: (entry: T) => string): Promise<Map<string, T>> {
	const entries = new Map<string, T>()
	const parsed = await readManifest<T[]>(path)

	for (const entry of parsed ?? []) {
		entries.set(key(entry), entry)
	}

	return entries
}

/**
 * Write a MANIFEST.json in the house shape: pretty-printed, trailing newline.
 */
export async function writeManifest(path: string, manifest: unknown): Promise<void> {
	await writeLocalTextFile(JSON.stringify(manifest, null, 2) + "\n", path)
}

/**
 * The sibling `MANIFEST.json` shape for a source that is a COLLECTION of files behind one portal (a monthly register
 * published per region, per industry, or per first letter). It carries what a trained artifact has to be able to cite
 * later: the license the portal labels the data with, the attribution wording it requires, and one
 * {@link SourceManifest} per file.
 */
export interface SourceCollectionManifest {
	source: string
	source_url: string
	license: string
	attribution: string
	downloaded_at: string
	files: SourceManifest[]
}

/**
 * Pipe a response body to `dest` and answer the byte count. The one primitive the portal fetchers share when the
 * request is not a bare GET — a session cookie, a CSRF header, or a form POST stands between the listing and the file,
 * so {@link streamDownload}'s URL-only contract does not fit and each module builds its own `Response` first. Writes a
 * `.tmp` sibling and renames, so an interrupted transfer never lands at the final path looking complete.
 */
export async function streamBodyToFile(res: Response, dest: string): Promise<number> {
	if (!res.body) throw new HTTPStatusError(res.status, `HTTP ${res.status} with no body — ${res.url}`)
	let bytes = 0

	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			bytes += chunk.byteLength
			controller.enqueue(chunk)
		},
	})

	const tmp = dest + ".tmp"
	await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), openWriteStream(tmp))
	await movePath(tmp, dest)

	return bytes
}

/**
 * The per-file entries of a {@link SourceCollectionManifest} keyed by file name, or an empty map when the manifest is
 * missing or not in the collection shape, so a re-run after an interruption fetches only what is missing. The
 * single-file modules' `loadManifestEntries` reads a bare array and is not this.
 */
export async function loadCollectionFiles(path: string): Promise<Map<string, SourceManifest>> {
	const parsed = await readManifest<SourceCollectionManifest>(path)
	const entries = new Map<string, SourceManifest>()

	for (const entry of Array.isArray(parsed?.files) ? parsed.files : []) {
		entries.set(entry.filename, entry)
	}

	return entries
}

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
