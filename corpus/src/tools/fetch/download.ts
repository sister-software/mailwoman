/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Download + manifest plumbing for the `mailwoman corpus fetch <source>` family — one download-with-retry and
 *   one MANIFEST.json idiom instead of the per-script clones the 2026-07-09 dedupe survey counted
 *   (6× `downloadToFile`, 2× `isTransientStatus`, 9× manifest writes).
 */

import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"

/** A status worth retrying: rate limiting or a server-side failure. */
export function isTransientStatus(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599)
}

export interface DownloadOptions {
	url: string
	dest: string
	/** Per-attempt timeout. Default 10 minutes — these are multi-GB government dumps. */
	timeoutMs?: number
	/** Extra attempts after the first, taken only on transient statuses or network errors. Default 0. */
	retries?: number
	/** Delay between attempts. Default 5s. */
	retryDelayMs?: number
	headers?: Record<string, string>
	report?: (line: string) => void
}

/**
 * Download `url` to `dest` with per-attempt timeout and transient-status retry. Throws on a non-transient HTTP status
 * or once retries are exhausted. Returns the byte count written.
 */
export async function downloadToFile(options: DownloadOptions): Promise<{ bytes: number }> {
	const { url, dest, timeoutMs = 600_000, retries = 0, retryDelayMs = 5_000, headers, report } = options
	let lastError: unknown

	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt > 0) {
			report?.(`retry ${attempt}/${retries} after ${retryDelayMs}ms — ${url}`)
			await sleep(retryDelayMs)
		}

		let res: Response

		try {
			res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
		} catch (error) {
			// AbortSignal timeouts and network-level failures are retryable.
			lastError = error
			continue
		}

		if (!res.ok) {
			const error = new Error(`HTTP ${res.status} ${res.statusText} — ${url}`)

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

/** Read a MANIFEST.json; `null` when missing or corrupt (callers re-fetch from scratch). */
export async function readManifest<T>(path: string): Promise<T | null> {
	if (!existsSync(path)) return null

	try {
		return JSON.parse(await readFile(path, "utf8")) as T
	} catch {
		return null
	}
}

/** Load manifest entries into a map so untouched keys survive a partial re-fetch. */
export async function loadManifestEntries<T>(path: string, key: (entry: T) => string): Promise<Map<string, T>> {
	const entries = new Map<string, T>()
	const parsed = await readManifest<T[]>(path)

	for (const entry of parsed ?? []) {
		entries.set(key(entry), entry)
	}

	return entries
}

/** Write a MANIFEST.json in the house shape: pretty-printed, trailing newline. */
export async function writeManifest(path: string, manifest: unknown): Promise<void> {
	await writeFile(path, JSON.stringify(manifest, null, 2) + "\n")
}
