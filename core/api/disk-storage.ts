/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file An on-disk `axios-cache-interceptor` storage adapter, so a client gets a durable HTTP cache by
 *   CONFIGURATION rather than by hand-rolling one (3b task 5).
 *
 *   NODE ONLY, and deliberately NOT re-exported from `./index.ts`: `core/api` reaches a browser bundle
 *   (`docs`'s `DashboardMap` → `@mailwoman/cartographer` → `tiles/api.ts` → `@mailwoman/core/api`),
 *   and webpack refuses to resolve `node:fs/promises` for the web target. Import this through its own
 *   `@mailwoman/core/api/disk-storage` subpath.
 *
 *   Two rules here are load-bearing, both carried over from the bespoke cache this replaces
 *   (`98c4dda1:filer/sdk/sec-client.ts`), both learned the hard way:
 *
 *     1. VALIDATE BEFORE WRITING. A response that can't be read back — an unparseable body, a
 *        non-finite TTL — must never reach disk. A permanently-cached entry has no self-healing path
 *        short of hand-deleting a hash-named file.
 *     2. ATOMIC WRITE, UNIQUE TEMP NAME. Write-then-rename, with a temp name unique per write. A
 *        DETERMINISTIC temp name (`${final}.building`) made two clients writing one URL collide: the
 *        first `rename()` moved the shared temp file away and the second got a raw `ENOENT` for a
 *        response that had already succeeded (reproduced 6/6), and at multi-MB bodies the two writers'
 *        bytes interleaved into a corrupt-but-parseable entry.
 */

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { type AxiosStorage, buildStorage, type NotEmptyStorageValue, type StorageValue } from "axios-cache-interceptor"

import { ConsoleLogger, type IRuntimeLogger } from "../logging/index.ts"
import { sha256Hex } from "../utils/hash.ts"

/**
 * Options for {@linkcode buildDiskStorage}.
 */
export interface DiskStorageOptions {
	/**
	 * The directory cache entries live in. Created on first write (recursively).
	 */
	directory: string
	/**
	 * An additional, domain-specific gate run against every entry BEFORE it is written. Return `false` (or throw) to drop
	 * the write; the entry is removed rather than persisted, so the next request re-fetches.
	 *
	 * This is the seam for "a 200 whose body isn't what this API is supposed to return". Some upstreams (SEC EDGAR among
	 * them) serve an HTML error page with a 200 status; persisting one under a permanent TTL poisons that URL forever.
	 * The structural checks below (serializable, finite `createdAt`/`ttl`) always run regardless.
	 */
	validate?: (value: NotEmptyStorageValue) => boolean
	/**
	 * Where rejected writes and unreadable entries are reported. Defaults to a `disk-storage`-prefixed console logger.
	 */
	logger?: IRuntimeLogger
}

/**
 * Whether a storage value is one worth persisting. `loading` is an in-flight marker with no reusable body — it belongs
 * in memory (see {@linkcode buildDiskStorage}'s in-process overlay), not in a file that would outlive the process that
 * wrote it and block every later request for that key.
 */
function isPersistableState(value: NotEmptyStorageValue): boolean {
	return value.state !== "loading"
}

/**
 * The structural half of the validate-before-write rule: an entry must survive a JSON round trip WITH ITS MEANING
 * INTACT.
 *
 * `createdAt` and `ttl` get an explicit finite check because `JSON.stringify(Infinity)` is the string `null`, and
 * `null` reads back as `0` in the interceptor's `createdAt + ttl < Date.now()` expiry test. An `Infinity` TTL — the
 * obvious way to spell "cache this immutable document forever" — would therefore round-trip into an entry that is
 * expired the instant it is read. Rejecting it loudly beats silently caching nothing.
 */
function hasFiniteTiming(value: NotEmptyStorageValue): boolean {
	if (value.createdAt !== undefined && !Number.isFinite(value.createdAt)) return false

	return value.ttl === undefined || Number.isFinite(value.ttl)
}

/**
 * Create an on-disk {@linkcode AxiosStorage}, keyed by the SHA-256 of the interceptor's cache key (which already folds
 * in method, URL, params and body), so a filename is always a fixed-length, filesystem-safe hex digest.
 *
 * An in-process overlay Map sits in front of the files, and it is load-bearing for two reasons:
 *
 * 1. `loading` markers live there INSTEAD of on disk. That keeps the interceptor's stampede guard working (a concurrent
 *    second request for the same key sees `loading` and waits on the first) without a file write per request, and
 *    without an interrupted process leaving a `loading` marker on disk forever.
 * 2. A value being WRITTEN stays there until its `rename` lands. Without that, `set()` clearing the `loading` marker
 *    before the file exists opens a window where the key is in neither place, and a concurrent reader gets `empty` for
 *    a response that is already in hand — measured as 3 dispatches for 3 concurrent requests to one URL, i.e. the
 *    stampede guard fully defeated.
 */
export function buildDiskStorage(options: DiskStorageOptions): AxiosStorage {
	const { directory, validate } = options
	const logger = options.logger ?? ConsoleLogger.prefix("disk-storage")

	/**
	 * Values visible to this process ahead of (or instead of) the files: `loading` markers, which are never persisted,
	 * and entries mid-write, which are dropped once their `rename` lands. See the function docstring.
	 */
	const overlay = new Map<string, StorageValue>()

	function entryPath(key: string): string {
		return join(directory, `${sha256Hex(key)}.json`)
	}

	async function removeEntry(key: string): Promise<void> {
		overlay.delete(key)

		try {
			await unlink(entryPath(key))
		} catch {
			// A miss is the expected case for a key that was never persisted (or was already evicted).
		}
	}

	/**
	 * Serialize `value`, or return `null` when it must not reach disk. Every rejection path is logged with the key so a
	 * maintainer seeing a cache that never fills has something to grep for.
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

			return JSON.stringify(value)
		} catch (error) {
			logger.warn(`Refusing to cache ${key}: ${error instanceof Error ? error.message : String(error)}`)

			return null
		}
	}

	return buildStorage({
		find: async (key) => {
			const pending = overlay.get(key)

			if (pending) return pending

			let raw: string

			try {
				raw = await readFile(entryPath(key), "utf8")
			} catch {
				return undefined
			}

			try {
				return JSON.parse(raw) as StorageValue
			} catch {
				// A truncated or hand-edited entry is a miss, not a crash — re-fetching is always safe.
				logger.warn(`Discarding an unreadable cache entry for ${key}.`)

				await removeEntry(key)

				return undefined
			}
		},

		set: async (key, value) => {
			if (!isPersistableState(value)) {
				overlay.set(key, value)

				return
			}

			const serialized = serializeIfValid(key, value)

			if (serialized === null) {
				// Drop any older entry too: the interceptor is telling us this key's content just changed,
				// and keeping a superseded body would be worse than a miss.
				await removeEntry(key)

				return
			}

			// Publish to the overlay BEFORE the write and clear it only once the rename has landed, so the
			// key is continuously visible: the `loading` marker is replaced by the real value in the same
			// synchronous step, never by a gap.
			overlay.set(key, value)

			const finalPath = entryPath(key)
			// Unique per write — `process.pid` separates processes, `randomUUID()` separates concurrent
			// writes inside one. A deterministic name here is the ENOENT/interleaving bug in the file header.
			const buildingPath = `${finalPath}.${process.pid}.${randomUUID()}.building`

			try {
				await mkdir(directory, { recursive: true })
				await writeFile(buildingPath, serialized)
				await rename(buildingPath, finalPath)
			} finally {
				overlay.delete(key)
			}
		},

		remove: removeEntry,

		clear: async () => {
			overlay.clear()

			// Recreated rather than left absent: "the cache is empty" and "the cache directory vanished"
			// are different states to anything inspecting the data root, and only the first is intended.
			await rm(directory, { recursive: true, force: true })
			await mkdir(directory, { recursive: true })
		},
	})
}
