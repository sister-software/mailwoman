/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode buildDiskStorage} — the on-disk `axios-cache-interceptor` storage.
 */

import { APIClient } from "@mailwoman/core/api/APIClient"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { isTransientResourceError } from "@mailwoman/core/api/responses"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode, removePathIfPresent, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import type { CachedStorageValue, NotEmptyStorageValue } from "axios-cache-interceptor"
import type { PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const ONE_HOUR_MS = 60 * 60 * 1000

function directoryNames(directory: PathBuilderLike): Promise<string[]> {
	return Globerator.from("*", { cwd: directory, absolute: false, onlyFiles: false }).toArray()
}

function cachedValue(body: unknown, ttl: number = ONE_HOUR_MS): CachedStorageValue {
	return {
		state: "cached",
		createdAt: Date.now(),
		ttl,
		data: {
			data: body,
			headers: {},
			status: 200,
			statusText: "OK",
		},
	}
}

let directory: TemporaryDirectory

beforeEach(async () => {
	directory = await temporaryDirectory("disk-storage-test-")
})

afterEach(() => directory[Symbol.asyncDispose]())

describe("buildDiskStorage: round trip", () => {
	it("persists an entry and reads it back across two independent storage instances", async () => {
		const writer = buildDiskStorage({ directory: directory.path })

		await writer.set("https://example.invalid/a.json", cachedValue({ hello: "world" }))

		const reader = buildDiskStorage({ directory: directory.path })
		const found = await reader.get("https://example.invalid/a.json")

		expect(found.state).toBe("cached")
		expect((found as CachedStorageValue).data.data).toEqual({ hello: "world" })
	})

	it("keys entries by the full request key, so two keys never collide", async () => {
		const storage = buildDiskStorage({ directory: directory.path })

		await storage.set("GET|https://example.invalid/x?cik=1", cachedValue({ cik: 1 }))
		await storage.set("GET|https://example.invalid/x?cik=2", cachedValue({ cik: 2 }))

		expect(await directoryNames(directory.path)).toHaveLength(2)

		expect(((await storage.get("GET|https://example.invalid/x?cik=1")) as CachedStorageValue).data.data).toEqual({
			cik: 1,
		})
	})

	it("treats an expired entry as a miss and evicts the file", async () => {
		const storage = buildDiskStorage({ directory: directory.path })
		const expired: CachedStorageValue = { ...cachedValue({ stale: true }, 1), createdAt: Date.now() - 10_000 }

		await storage.set("expired", expired)
		expect(await directoryNames(directory.path)).toHaveLength(1)

		expect((await storage.get("expired")).state).toBe("empty")
		expect(await directoryNames(directory.path)).toHaveLength(0)
	})

	it("removes an entry on request, and clears the whole directory.path", async () => {
		const storage = buildDiskStorage({ directory: directory.path })

		await storage.set("a", cachedValue({ a: 1 }))
		await storage.set("b", cachedValue({ b: 2 }))

		await storage.remove("a")
		expect(await directoryNames(directory.path)).toHaveLength(1)

		await storage.clear?.()

		expect(
			await Globerator.from("*", { cwd: directory.path, withFileTypes: true, onlyFiles: false }).toArray()
		).toHaveLength(0)
	})

	it("holds `loading` markers in memory only — never a file per in-flight request", async () => {
		const storage = buildDiskStorage({ directory: directory.path })

		await storage.set("in-flight", { state: "loading", previous: "empty" })

		expect(await directoryNames(directory.path)).toHaveLength(0)
		expect((await storage.get("in-flight")).state).toBe("loading")

		// A separate instance (a separate process, in production) must see a clean miss
		// rather than a `loading` marker it can never resolve.
		expect((await buildDiskStorage({ directory: directory.path }).get("in-flight")).state).toBe("empty")
	})

	it("keeps a key continuously visible across the write, never showing a gap", async () => {
		// The `loading` marker must be replaced by the real value in one step: clearing it
		// before the file lands leaves the key in neither place, and a concurrent reader gets
		// `empty` for a response already in hand, defeating the cache interceptor's stampede guard.
		const storage = buildDiskStorage({ directory: directory.path })

		await storage.set("k", { state: "loading", previous: "empty" })

		const write = storage.set("k", cachedValue({ v: 1 }))
		const during = await storage.get("k")

		await write

		expect(during.state).toBe("cached")
		expect((during as CachedStorageValue).data.data).toEqual({ v: 1 })
	})

	it("treats a corrupt file as a miss and evicts it rather than throwing", async () => {
		const storage = buildDiskStorage({ directory: directory.path })

		await storage.set("corrupt", cachedValue({ good: true }))

		const [fileName] = await directoryNames(directory.path)

		await writeLocalTextFile("{ not json", directory.path(fileName!))

		expect((await storage.get("corrupt")).state).toBe("empty")
		expect(await directoryNames(directory.path)).toHaveLength(0)
	})
})

describe("buildDiskStorage: validate BEFORE writing", () => {
	it("never writes an entry the configured validator rejects, and the next read is a clean miss", async () => {
		const storage = buildDiskStorage({
			directory: directory.path,
			validate: (value: NotEmptyStorageValue) => typeof value.data?.data !== "string",
		})

		await storage.set("poisoned", cachedValue("<html>not json</html>"))

		expect(await directoryNames(directory.path)).toHaveLength(0)
		expect((await storage.get("poisoned")).state).toBe("empty")

		await storage.set("poisoned", cachedValue({ ok: true }))
		expect(await directoryNames(directory.path)).toHaveLength(1)
	})

	it("drops a superseded entry rather than leaving the older body behind", async () => {
		let accept = true

		const storage = buildDiskStorage({
			directory: directory.path,
			validate: () => accept,
		})

		await storage.set("k", cachedValue({ generation: 1 }))
		expect(await directoryNames(directory.path)).toHaveLength(1)

		accept = false
		await storage.set("k", cachedValue({ generation: 2 }))

		expect(await directoryNames(directory.path)).toHaveLength(0)
		expect((await storage.get("k")).state).toBe("empty")
	})

	it("refuses a non-finite ttl, which JSON would silently turn into an already-expired entry", async () => {
		// `JSON.stringify(Infinity)` is `"null"`, which reads back as 0 in the interceptor's
		// `createdAt + ttl < Date.now()` expiry test, so "cache forever" would round-trip into already-expired.
		const storage = buildDiskStorage({ directory: directory.path })

		await storage.set("forever", cachedValue({ immutable: true }, Number.POSITIVE_INFINITY))

		expect(await directoryNames(directory.path)).toHaveLength(0)
	})

	it("refuses an unserializable body instead of throwing out of set()", async () => {
		const storage = buildDiskStorage({ directory: directory.path })
		const circular: Record<string, unknown> = {}

		circular.self = circular

		await expect(storage.set("circular", cachedValue(circular))).resolves.toBeUndefined()
		expect(await directoryNames(directory.path)).toHaveLength(0)
	})
})

describe("buildDiskStorage: atomic write with a per-write-unique temp name", () => {
	// A per-write-unique temp name is required: with a fixed `${finalPath}.building`,
	// two writers racing on the same key target the same temp file, and the second
	// gets a raw enoent for a response that had already succeeded.
	it("never throws and never corrupts when two independent writers race on the same key", async () => {
		const ROUNDS = 10
		const BODY_BYTES = 200_000

		for (let round = 0; round < ROUNDS; round++) {
			const key = `https://example.invalid/race.json?round=${round}`
			const body = { round, payload: "x".repeat(BODY_BYTES) }

			const writerA = buildDiskStorage({ directory: directory.path })
			const writerB = buildDiskStorage({ directory: directory.path })

			const before = new Set(await directoryNames(directory.path))

			await Promise.all([writerA.set(key, cachedValue(body)), writerB.set(key, cachedValue(body))])

			const added = (await directoryNames(directory.path)).filter((name) => !before.has(name))

			// Exactly one new file: not zero (both writes vanished), not two
			// (an orphaned `.building` left beside the final one).
			expect(added).toHaveLength(1)

			const entry = await readLocalJSONFile<CachedStorageValue>(directory.path(added[0]!))

			expect(entry.data.data).toEqual(body)
		}
	})

	it("leaves no .building temp file behind after a normal write", async () => {
		const storage = buildDiskStorage({ directory: directory.path })

		await storage.set("clean", cachedValue({ ok: true }))

		expect((await directoryNames(directory.path)).filter((name) => name.endsWith(".building"))).toHaveLength(0)
	})
})

describe("buildDiskStorage: a failed cache write is a cache miss, not a request failure", () => {
	/**
	 * Make `directory.path` unwritable and report whether it took, because running
	 * as root defeats mode bits and a test that silently passes without reproducing
	 * the condition is worse than one that says so.
	 */
	async function makeUnwritable(): Promise<boolean> {
		await changeMode(directory.path, 0o500)

		try {
			await writeLocalTextFile("x", directory.path("probe"))
			await removePathIfPresent(directory.path("probe"))

			return false
		} catch {
			return true
		}
	}

	async function restore(): Promise<void> {
		await changeMode(directory.path, 0o700)
	}

	it("resolves instead of throwing when the entry cannot be written", async () => {
		if (!(await makeUnwritable())) {
			await restore()
			throw new Error("could not make the cache directory.path unwritable (running as root?) — test cannot reproduce")
		}

		try {
			const storage = buildDiskStorage({ directory: directory.path })

			await expect(storage.set("k", cachedValue({ v: 1 }))).resolves.toBeUndefined()

			expect((await storage.get("k")).state).toBe("empty")
		} finally {
			await restore()
		}
	})

	it("leaves a SUCCESSFUL response intact through APIClient when the cache write fails", async () => {
		// `axios-cache-interceptor` awaits `storage.set` inside its response `onFulfilled`,
		// so a throwing write rejects a request whose HTTP response already succeeded as a
		// bare `Error` with no `status`, which `isTransientResourceError` reads as permanent.
		if (!(await makeUnwritable())) {
			await restore()
			throw new Error("could not make the cache directory.path unwritable (running as root?) — test cannot reproduce")
		}

		try {
			const client = new APIClient({
				displayName: "unwritable-cache",
				caching: { storage: buildDiskStorage({ directory: directory.path }) },
				axios: {
					adapter: async (config) => ({
						data: { ok: true },
						status: 200,
						statusText: "OK",
						headers: {},
						config,
					}),
				},
			})

			const response = await client.fetch<{ ok: boolean }>({ url: "/still-works.json" })

			expect(response.data).toEqual({ ok: true })
		} finally {
			await restore()
		}
	})

	it("keeps three concurrent requests consistent when the cache cannot be written", async () => {
		if (!(await makeUnwritable())) {
			await restore()
			throw new Error("could not make the cache directory.path unwritable (running as root?) — test cannot reproduce")
		}

		try {
			const client = new APIClient({
				displayName: "unwritable-cache-concurrent",
				caching: { storage: buildDiskStorage({ directory: directory.path }) },
				axios: {
					adapter: async (config) => ({
						data: { ok: true },
						status: 200,
						statusText: "OK",
						headers: {},
						config,
					}),
				},
			})

			const settled = await Promise.allSettled([
				client.fetch({ url: "/concurrent.json" }),
				client.fetch({ url: "/concurrent.json" }),
				client.fetch({ url: "/concurrent.json" }),
			])

			expect(settled.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"])

			for (const outcome of settled) {
				if (outcome.status === "rejected") {
					expect(isTransientResourceError(outcome.reason)).toBe(true)
				}
			}
		} finally {
			await restore()
		}
	})
})
