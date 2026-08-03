/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode buildDiskStorage} — the on-disk `axios-cache-interceptor` storage.
 *
 *   The two rules with history behind them get dedicated, mutation-proved coverage: validate BEFORE
 *   writing, and write atomically under a per-write-unique temp name.
 */

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CachedStorageValue, NotEmptyStorageValue } from "axios-cache-interceptor"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { APIClient } from "./APIClient.ts"
import { buildDiskStorage } from "./disk-storage.ts"
import { isTransientResourceError } from "./responses.ts"

const ONE_HOUR_MS = 60 * 60 * 1000

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

let directory: string

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "disk-storage-test-"))
})

afterEach(() => {
	rmSync(directory, { recursive: true, force: true })
})

describe("buildDiskStorage: round trip", () => {
	it("persists an entry and reads it back across two independent storage instances", async () => {
		const writer = buildDiskStorage({ directory })

		await writer.set("https://example.invalid/a.json", cachedValue({ hello: "world" }))

		const reader = buildDiskStorage({ directory })
		const found = await reader.get("https://example.invalid/a.json")

		expect(found.state).toBe("cached")
		expect((found as CachedStorageValue).data.data).toEqual({ hello: "world" })
	})

	it("keys entries by the full request key, so two keys never collide", async () => {
		const storage = buildDiskStorage({ directory })

		await storage.set("GET|https://example.invalid/x?cik=1", cachedValue({ cik: 1 }))
		await storage.set("GET|https://example.invalid/x?cik=2", cachedValue({ cik: 2 }))

		expect(readdirSync(directory)).toHaveLength(2)

		expect(((await storage.get("GET|https://example.invalid/x?cik=1")) as CachedStorageValue).data.data).toEqual({
			cik: 1,
		})
	})

	it("treats an expired entry as a miss and evicts the file", async () => {
		const storage = buildDiskStorage({ directory })
		const expired: CachedStorageValue = { ...cachedValue({ stale: true }, 1), createdAt: Date.now() - 10_000 }

		await storage.set("expired", expired)
		expect(readdirSync(directory)).toHaveLength(1)

		expect((await storage.get("expired")).state).toBe("empty")
		expect(readdirSync(directory)).toHaveLength(0)
	})

	it("removes an entry on request, and clears the whole directory", async () => {
		const storage = buildDiskStorage({ directory })

		await storage.set("a", cachedValue({ a: 1 }))
		await storage.set("b", cachedValue({ b: 2 }))

		await storage.remove("a")
		expect(readdirSync(directory)).toHaveLength(1)

		await storage.clear?.()
		expect(readdirSync(directory, { withFileTypes: true })).toHaveLength(0)
	})

	it("holds `loading` markers in memory only — never a file per in-flight request", async () => {
		const storage = buildDiskStorage({ directory })

		await storage.set("in-flight", { state: "loading", previous: "empty" })

		expect(readdirSync(directory)).toHaveLength(0)
		expect((await storage.get("in-flight")).state).toBe("loading")

		// And a separate instance (a separate process, in production) sees a clean miss rather than a
		// `loading` marker it can never resolve.
		expect((await buildDiskStorage({ directory }).get("in-flight")).state).toBe("empty")
	})

	it("keeps a key continuously visible across the write, never showing a gap", async () => {
		// The `loading` marker has to be replaced by the real value in one step. Clearing it before the
		// file lands leaves the key in neither place, and a concurrent reader gets `empty` for a response
		// already in hand — measured as 3 dispatches for 3 concurrent requests to one URL through
		// `APIClient`, i.e. the cache interceptor's stampede guard fully defeated.
		const storage = buildDiskStorage({ directory })

		await storage.set("k", { state: "loading", previous: "empty" })

		const write = storage.set("k", cachedValue({ v: 1 }))
		const during = await storage.get("k")

		await write

		expect(during.state).toBe("cached")
		expect((during as CachedStorageValue).data.data).toEqual({ v: 1 })
	})

	it("treats a corrupt file as a miss and evicts it rather than throwing", async () => {
		const storage = buildDiskStorage({ directory })

		await storage.set("corrupt", cachedValue({ good: true }))

		const [fileName] = readdirSync(directory)

		writeFileSync(join(directory, fileName!), "{ not json")

		expect((await storage.get("corrupt")).state).toBe("empty")
		expect(readdirSync(directory)).toHaveLength(0)
	})
})

describe("buildDiskStorage: validate BEFORE writing", () => {
	it("never writes an entry the configured validator rejects, and the next read is a clean miss", async () => {
		// The historical failure: a 200 carrying an HTML error page was cached under a permanent TTL, so
		// every later request replayed the poisoned entry forever with no self-healing path.
		const storage = buildDiskStorage({
			directory,
			validate: (value: NotEmptyStorageValue) => typeof value.data?.data !== "string",
		})

		await storage.set("poisoned", cachedValue("<html>not json</html>"))

		expect(readdirSync(directory)).toHaveLength(0)
		expect((await storage.get("poisoned")).state).toBe("empty")

		// Self-heals: a later, valid response for the same key caches normally.
		await storage.set("poisoned", cachedValue({ ok: true }))
		expect(readdirSync(directory)).toHaveLength(1)
	})

	it("drops a superseded entry rather than leaving the older body behind", async () => {
		let accept = true

		const storage = buildDiskStorage({
			directory,
			validate: () => accept,
		})

		await storage.set("k", cachedValue({ generation: 1 }))
		expect(readdirSync(directory)).toHaveLength(1)

		accept = false
		await storage.set("k", cachedValue({ generation: 2 }))

		expect(readdirSync(directory)).toHaveLength(0)
		expect((await storage.get("k")).state).toBe("empty")
	})

	it("refuses a non-finite ttl, which JSON would silently turn into an already-expired entry", async () => {
		// `JSON.stringify(Infinity)` is `"null"`, and `null` reads back as 0 in the interceptor's
		// `createdAt + ttl < Date.now()` expiry test — so "cache forever" would round-trip into
		// "expired the instant it is read". Rejecting loudly beats caching nothing.
		const storage = buildDiskStorage({ directory })

		await storage.set("forever", cachedValue({ immutable: true }, Number.POSITIVE_INFINITY))

		expect(readdirSync(directory)).toHaveLength(0)
	})

	it("refuses an unserializable body instead of throwing out of set()", async () => {
		const storage = buildDiskStorage({ directory })
		const circular: Record<string, unknown> = {}

		circular.self = circular

		await expect(storage.set("circular", cachedValue(circular))).resolves.toBeUndefined()
		expect(readdirSync(directory)).toHaveLength(0)
	})
})

describe("buildDiskStorage: atomic write with a per-write-unique temp name", () => {
	// The per-write-unique temp name is load-bearing, and a deterministic one is the tempting mistake.
	// With a fixed `${finalPath}.building`, two writers racing on the same key target the same temp file:
	// the first `rename()` moves it away and the second gets a raw ENOENT for a response that had already
	// succeeded (reproduces 6/6), and with large bodies the interleaved writes can also leave a
	// corrupt-but-parseable entry (2/10). 10 rounds at 200KB, two independent storage instances.
	it("never throws and never corrupts when two independent writers race on the same key", async () => {
		const ROUNDS = 10
		const BODY_BYTES = 200_000

		for (let round = 0; round < ROUNDS; round++) {
			const key = `https://example.invalid/race.json?round=${round}`
			const body = { round, payload: "x".repeat(BODY_BYTES) }

			const writerA = buildDiskStorage({ directory })
			const writerB = buildDiskStorage({ directory })

			const before = new Set(readdirSync(directory))

			await Promise.all([writerA.set(key, cachedValue(body)), writerB.set(key, cachedValue(body))])

			const added = readdirSync(directory).filter((name) => !before.has(name))

			// Exactly one: not zero (both writes vanished), not two (an orphaned `.building` file left
			// behind alongside the final one — the old bug's ENOENT path did exactly that).
			expect(added).toHaveLength(1)

			const entry = JSON.parse(readFileSync(join(directory, added[0]!), "utf8")) as CachedStorageValue

			expect(entry.data.data).toEqual(body)
		}
	})

	it("leaves no .building temp file behind after a normal write", async () => {
		const storage = buildDiskStorage({ directory })

		await storage.set("clean", cachedValue({ ok: true }))

		expect(readdirSync(directory).filter((name) => name.endsWith(".building"))).toHaveLength(0)
	})
})

describe("buildDiskStorage: a failed cache write is a cache miss, not a request failure", () => {
	/**
	 * Make `directory` unwritable and report whether it took. Running as root defeats mode bits entirely, and a test that
	 * silently passes because it could not reproduce the condition is worse than one that says so.
	 */
	function makeUnwritable(): boolean {
		chmodSync(directory, 0o500)

		try {
			writeFileSync(join(directory, "probe"), "x")
			rmSync(join(directory, "probe"), { force: true })

			return false
		} catch {
			return true
		}
	}

	function restore(): void {
		chmodSync(directory, 0o700)
	}

	it("resolves instead of throwing when the entry cannot be written", async () => {
		if (!makeUnwritable()) {
			restore()
			throw new Error("could not make the cache directory unwritable (running as root?) — test cannot reproduce")
		}

		try {
			const storage = buildDiskStorage({ directory })

			await expect(storage.set("k", cachedValue({ v: 1 }))).resolves.toBeUndefined()

			// And the key reads back as a plain miss, not as a half-written entry.
			expect((await storage.get("k")).state).toBe("empty")
		} finally {
			restore()
		}
	})

	it("leaves a SUCCESSFUL response intact through APIClient when the cache write fails", async () => {
		// The contract, end to end: `axios-cache-interceptor` awaits `storage.set` inside its response
		// `onFulfilled`, so a throwing write rejects a request whose HTTP response already succeeded. It
		// escapes as a bare `Error` — no `status` — which `isTransientResourceError` reads as FALSE, so a
		// caller is told the failure is permanent and drops the work. ANY filesystem error does this;
		// reproduced here with a `0o500` parent.
		if (!makeUnwritable()) {
			restore()
			throw new Error("could not make the cache directory unwritable (running as root?) — test cannot reproduce")
		}

		try {
			const client = new APIClient({
				displayName: "unwritable-cache",
				caching: { storage: buildDiskStorage({ directory }) },
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
			restore()
		}
	})

	it("keeps three concurrent requests consistent when the cache cannot be written", async () => {
		// The same repro showed one rejection and two successes for the SAME response — a request's
		// outcome depending on whether it happened to be the one that lost a cache-write race.
		if (!makeUnwritable()) {
			restore()
			throw new Error("could not make the cache directory unwritable (running as root?) — test cannot reproduce")
		}

		try {
			const client = new APIClient({
				displayName: "unwritable-cache-concurrent",
				caching: { storage: buildDiskStorage({ directory }) },
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
			restore()
		}
	})
})
