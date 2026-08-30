/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Download and manifest utilities for `mailwoman corpus fetch <source>`.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { tryParsingJSON } from "@mailwoman/core/objects"
import { readFile, writeFile } from "@mailwoman/platform/fs/promises"
import { setTimeout as sleep } from "@mailwoman/platform/timers/promises"

/**
 * Rate limited — retryable, the server is asking us to back off.
 */
const HTTP_TOO_MANY_REQUESTS = 429

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
	outRoot: string
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
 * A status worth retrying: rate limiting or a server-side failure.
 */
/**
 * An HTTP failure that CARRIES its status, so callers branch on `error.status` rather than on message prose. The prose
 * route shipped a real flake: a caller classified "not published upstream" with `message.includes("404")`, and the
 * message contains the URL — an ephemeral test-server port such as `:40453` satisfies it while the actual status is
 * 500. Roughly 1–2% of ephemeral ports contain the substring, which is exactly the kind of sometimes-failure that burns
 * a CI run and vanishes locally.
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
			await writeFile(dest, buffer)

			return { bytes: buffer.byteLength }
		} catch (error) {
			// A mid-stream abort while reading the body is retryable too.
			lastError = error
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Read a MANIFEST.json; `null` when missing or corrupt (callers re-fetch from scratch).
 */
export async function readManifest<T>(path: string): Promise<T | null> {
	if (!(await pathExists(path))) return null

	// A read failure (e.g. the file vanished after the existsSync probe) maps to null like corrupt
	// JSON does; tryParsingJSON returns null for the non-string sentinel.
	const text = await readFile(path, "utf8").catch(() => null)

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
	await writeFile(path, JSON.stringify(manifest, null, 2) + "\n")
}
