/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file An on-disk `axios-cache-interceptor` storage adapter, so a client gets a durable http cache by
 *   configuration rather than by hand-rolling one.
 *
 *   Node only, and deliberately not re-exported from `./index.ts`: `core/api` reaches a browser bundle
 *   (`docs`'s `DashboardMap` → `@mailwoman/cartographer` → `tiles/api.ts` → `@mailwoman/core/api`),
 *   and webpack refuses to resolve `node:fs/promises` for the web target. Import this through its own
 *   `@mailwoman/core/api/disk-storage` subpath.
 *
 *   Two rules here are required:
 *
 *     1. validate before writing. A response that can't be read back — an unparseable body, a
 *        non-finite TTL — must never reach disk. A permanently-cached entry has no self-healing path
 *        short of hand-deleting a hash-named file.
 *     2. atomic write, unique temp name. Write-then-rename, with a temp name unique per write. A
 *        deterministic temp name (`${final}.building`) lets two clients writing one URL collide: the
 *        first `rename()` moves the shared temp file away and the second gets a raw `enoent` for a
 *        response that had already succeeded, and at multi-MB bodies the two writers' bytes can
 *        interleave into a corrupt-but-parseable entry.
 */

import { type AxiosStorage, buildStorage, type NotEmptyStorageValue, type StorageValue } from "axios-cache-interceptor"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { errorMessage } from "#errors/schema"
import { readLocalTextFile } from "#fs/readers"
import { makeDirectories, movePath, removePath, removePathIfPresent, writeLocalFile } from "#fs/writers"
import { sha256Hex } from "#hash"
import { tryParsingJSON, stringifyJSON } from "#json"
import { ConsoleLogger, type IRuntimeLogger } from "#logging/index"

/**
 * Options for {@linkcode buildDiskStorage}.
 */
export interface DiskStorageOptions {
	/**
	 * The directory cache entries live in.
	 *
	 * Created on first write (recursively).
	 */
	directory: PathBuilderLike
	/**
	 * An additional, domain-specific check run against every entry before it is written: return `false`
	 * (or throw) to drop the write, so the entry is removed and the next request re-fetches.
	 *
	 * This is the hook for "a 200 whose body isn't what this API is supposed to return" —
	 * some upstreams (SEC edgar among them) serve an html error page with a 200 status,
	 * and persisting one under a permanent TTL poisons that URL forever.
	 *
	 * The structural checks (serializable, finite `createdAt`/`ttl`) always run regardless.
	 */
	validate?: (value: NotEmptyStorageValue) => boolean
	/**
	 * Where rejected writes and unreadable entries are reported.
	 *
	 * Defaults to a `disk-storage`-prefixed console logger.
	 */
	logger?: IRuntimeLogger
}

/**
 * Whether a storage value is one worth persisting: `loading` is an in-flight marker with no reusable
 * body, so it belongs in the in-process overlay (see {@linkcode buildDiskStorage}) rather than in
 * a file that would outlive the process that wrote it and block every later request for that key.
 */
function isPersistableState(value: NotEmptyStorageValue): boolean {
	return value.state !== "loading"
}

/**
 * The structural half of the validate-before-write rule: an entry must survive
 * a JSON round trip with its meaning intact.
 *
 * `createdAt` and `ttl` get an explicit finite check because `JSON.stringify(Infinity)` is the string
 * `null`, and `null` reads back as `0` in the interceptor's `createdAt + ttl < Date.now()` expiry test.
 * An `Infinity` TTL — the obvious way to spell "cache this immutable document forever" —
 * would therefore round-trip into an entry that is expired the instant it is read.
 */
function hasFiniteTiming(value: NotEmptyStorageValue): boolean {
	if (value.createdAt !== undefined && !Number.isFinite(value.createdAt)) return false

	return value.ttl === undefined || Number.isFinite(value.ttl)
}

/**
 * Create an on-disk {@linkcode AxiosStorage}, keyed by the SHA-256 of the
 * interceptor's cache key (which already folds in method, URL, params and body),
 * so a filename is always a fixed-length, filesystem-safe hex digest.
 *
 * An in-process overlay Map sits in front of the files, and it is required for two reasons:
 *
 * 1. `loading` markers live there instead of on disk.
 *    That keeps the interceptor's stampede guard working (a concurrent second request for
 *    the same key sees `loading` and waits on the first) without a file write per request,
 *    and without an interrupted process leaving a `loading` marker on disk forever.
 * 2. A value being written stays there until its `rename` lands.
 *    Without that, `set()` clearing the `loading` marker before the file exists opens a window
 *    where the key is in neither place, and a concurrent reader gets `empty` for a
 *    response that is already in hand — which defeats the stampede guard.
 */
export function buildDiskStorage(options: DiskStorageOptions): AxiosStorage {
	const { validate } = options
	const directory = PathBuilder.from(options.directory)
	const logger = options.logger ?? ConsoleLogger.prefix("disk-storage")

	const overlay = new Map<string, StorageValue>()

	function entryPath(key: string): PathBuilder {
		return directory(`${sha256Hex(key)}.json`)
	}

	async function removeEntry(key: string): Promise<void> {
		overlay.delete(key)

		try {
			await removePath(entryPath(key))
		} catch {
			// A miss is the expected case for a key that was never persisted (or was already evicted).
		}
	}

	/**
	 * Serialize `value`, or return `null` when it must not reach disk, logging every rejection
	 * with the key so a maintainer seeing a cache that never fills has something to grep for.
	 */
	function serializeIfValid(key: string, value: NotEmptyStorageValue): string | null {
		if (!hasFiniteTiming(value)) {
			logger.warn(`Refusing to cache ${key}: createdAt/ttl must be finite (received ttl=${String(value.ttl)}).`)

			return null
		}

		try {
			if (validate && !validate(value)) {
				logger.warn(`Refusing to cache ${key}: rejected by the configured validate() predicate.`)

				return null
			}

			return stringifyJSON(value)
		} catch (error) {
			logger.warn(`Refusing to cache ${key}: ${errorMessage(error)}`)

			return null
		}
	}

	return buildStorage({
		find: async (key) => {
			const pending = overlay.get(key)

			if (pending) return pending

			let raw: string

			try {
				raw = await readLocalTextFile(entryPath(key))
			} catch {
				return undefined
			}

			const parsed = tryParsingJSON<StorageValue>(raw)

			if (parsed === null) {
				// A truncated or hand-edited entry is a miss rather than a crash — re-fetching is always safe.
				logger.warn(`Discarding an unreadable cache entry for ${key}.`)

				await removeEntry(key)

				return undefined
			}

			return parsed
		},

		set: async (key, value) => {
			if (!isPersistableState(value)) {
				overlay.set(key, value)

				return
			}

			const serialized = serializeIfValid(key, value)

			if (serialized === null) {
				// Drop any older entry too: the interceptor is telling us this key's content
				// just changed, and keeping a superseded body would be worse than a miss.
				await removeEntry(key)

				return
			}

			// Publish to the overlay before the write and clear it only once the rename has landed,
			// so the key is continuously visible: the `loading` marker is replaced by the
			// real value in the same synchronous step, never by a gap.
			overlay.set(key, value)

			const finalPath = entryPath(key)
			// Unique per write: `process.pid` separates processes, `randomUUID()` separates concurrent
			// writes inside one; a deterministic name collides as the file header describes.
			const buildingPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.building`

			try {
				await makeDirectories(directory)
				await writeLocalFile(serialized, buildingPath)
				await movePath(buildingPath, finalPath)
			} catch (error) {
				// A cache write follows a successful request, so if the write fails the request still succeeds.
				// `axios-cache-interceptor` awaits `set()` inside its response `onFulfilled`,
				// so throwing from here rejects a request whose http response already succeeded —
				// the body is discarded — and it escapes as a bare `Error` with no `status`,
				// so `isTransientResourceError` reads it as false and a caller following
				// the documented interface is told never to retry.
				// Any filesystem failure does this.
				// Not being able to cache is a cache miss.
				logger.warn(`Could not persist ${key} (continuing as a cache miss): ${errorMessage(error)}`)

				// Best-effort cleanup of the temp file, if the failure came after it was created.
				await removePath(buildingPath).catch(() => undefined)
			} finally {
				overlay.delete(key)
			}
		},

		remove: removeEntry,

		clear: async () => {
			overlay.clear()

			// Recreated rather than left absent: "the cache is empty" and "the cache directory vanished" are
			// different states to anything inspecting the data root, and only the first is intended.
			await removePathIfPresent(directory)
			await makeDirectories(directory)
		},
	})
}
