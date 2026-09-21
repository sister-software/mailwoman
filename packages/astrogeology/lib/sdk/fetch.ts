/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pinned fetch. A source lands under `$MAILWOMAN_DATA_ROOT/astrogeology/<body>/source/` and its byte count and
 *   SHA-256 go into `sources.lock.json`, which is committed and which this module alone writes. A cached file whose
 *   size differs from the lock, a product whose size differs from the source table, or a re-fetch whose hash differs
 *   from the lock all refuse, naming both values: no pin drifts silently.
 *
 *   The transfer itself is `streamToDisk` from `@mailwoman/core/utils`: a file transfer on raw `fetch`, with the
 *   `.part` rename that keeps an interrupted download from presenting as a finished one.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalJSONFile, statPath } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { isoDate, isoSeconds, streamToDisk } from "@mailwoman/core/utils"
import { basename, dirname, extname, type PathBuilderLike } from "path-ts"

import { type LockedSource, type SourcesLock, SourcesLockSchema } from "#schema/manifest"
import type { PlanetarySource } from "#sdk/sources"

export interface FetchedSource {
	path: PathBuilderLike
	bytes: number
	sha256: string
	/**
	 * True when the locked file was already on disk and the transfer was skipped.
	 */
	reused: boolean
}

export interface DownloadPinnedOptions {
	/**
	 * The day a nightly archive is taken as, `yyyy-MM-DD`. @default today
	 */
	snapshotDate?: string
	onProgress?: (message: string) => void
}

const LOCK_PATH = resolvePackagePath("@mailwoman/astrogeology", "sources.lock.json")

/**
 * The committed lock, or an empty one before the first fetch.
 */
export async function readLock(): Promise<SourcesLock> {
	if (!(await pathExists(LOCK_PATH))) return {}

	return SourcesLockSchema.parse(await readLocalJSONFile(LOCK_PATH))
}

/**
 * Write the lock with its keys sorted, so a re-fetch of one source is a one-entry diff.
 */
async function writeLock(lock: SourcesLock): Promise<void> {
	const sorted = Object.fromEntries(
		Object.entries(SourcesLockSchema.parse(lock)).toSorted(([a], [b]) => a.localeCompare(b))
	)

	await writeLocalJSONFile(sorted, LOCK_PATH)
}

/**
 * Resolve the cached file path for a source.
 *
 * Snapshot-pinned sources use `<source.id>-<snapshot><ext>` so each day gets a distinct file.
 *
 * Product-pinned sources keep the original filename from the URL.
 */
function sourceCachePath(source: PlanetarySource, snapshot: string | undefined) {
	const fileName = snapshot ? `${source.id}-${snapshot}${extname(source.url)}` : basename(source.url)

	return dataRootPath("astrogeology", source.body, "source", fileName)
}

/**
 * Fetch a source once and pin it, or answer the pinned file already on disk.
 */
export async function downloadPinned(
	source: PlanetarySource,
	options: DownloadPinnedOptions = {}
): Promise<FetchedSource> {
	const lock = await readLock()
	const locked: LockedSource | undefined = lock[source.id]
	const snapshot = source.pinned === "snapshot" ? (options.snapshotDate ?? locked?.snapshot ?? isoDate()) : undefined
	const path = sourceCachePath(source, snapshot)

	const onDisk = await pathExists(path)

	if (locked && onDisk) {
		const bytes = (await statPath(path)).size

		if (bytes !== locked.bytes) {
			throw new Error(
				`${source.id}: cached ${bytes} bytes, lock says ${locked.bytes} — the cache is not the pinned file`
			)
		}

		return {
			path,
			bytes,
			sha256: locked.sha256,
			reused: true,
		}
	}

	// A file at the final path finished (the transfer renames from `.part` only on a clean end),
	// so a complete file with no pin is hashed and pinned rather than fetched again.
	// The size check below still holds it to the table.
	if (!onDisk) {
		// The transfer opens its `.part` stream in place.
		// The source directory is this fetch's to create.
		await makeDirectories(dirname(path))

		await streamToDisk({
			url: source.url,
			destination: path,
			context: source.id,
			onProgress: options.onProgress,
		})
	}

	const bytes = (await statPath(path)).size

	if (source.expectedBytes !== null && bytes !== source.expectedBytes) {
		throw new Error(
			`${source.id}: ${bytes} bytes downloaded, ${source.expectedBytes} expected — the product changed under its URL`
		)
	}

	const sha256 = await sha256File(path)

	if (locked && locked.sha256 !== sha256) {
		throw new Error(
			`${source.id}: sha256 ${sha256} differs from the lock's ${locked.sha256} — review the source before re-pinning`
		)
	}

	// Re-read before writing: a transfer runs for minutes, and a lock read before it
	// started would write back over every pin another fetch recorded meanwhile.
	await writeLock({
		...(await readLock()),
		[source.id]: { url: source.url, bytes, sha256, fetchedAt: isoSeconds(), ...(snapshot ? { snapshot } : {}) },
	})

	return { path, bytes, sha256, reused: false }
}
