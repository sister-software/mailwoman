// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The client half of the protocol: which `open` request each opener posts.
 *
 *   The worker half runs only in a browser and is covered by the docs Playwright suite.
 */

import { afterEach, describe, expect, test, vi } from "vitest"

import {
	DEFAULT_CHUNK_CACHE_BYTES,
	DEFAULT_CHUNK_SIZE,
	isSQLiteReadFailure,
	openRangeDatabase,
	openWholeDatabase,
	rangeWorkerMemory,
	RangeWorkerError,
} from "#httpvfs/database"
import type { RangeWorkerCall } from "#httpvfs/worker-protocol"

class FakeWorker extends EventTarget {
	static posted: RangeWorkerCall[] = []
	static created: FakeWorker[] = []

	readonly url: string

	constructor(url: string) {
		super()
		this.url = url
		FakeWorker.created.push(this)
	}

	postMessage(call: RangeWorkerCall): void {
		FakeWorker.posted.push(call)

		const result =
			call.type === "open"
				? { sqliteVersion: "3.53.0" }
				: call.type === "query"
					? [{ n: 1 }]
					: { requests: 1, bytes: 4, cachedBytes: 4096 }

		queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id: call.id, result } })))
	}

	terminate(): void {}
}

/**
 * A worker whose queries of the `candidate` table fail the way sqlite-wasm reports a failed page read.
 */
class FailingReadWorker extends FakeWorker {
	override postMessage(call: RangeWorkerCall): void {
		if (call.type === "query" && call.sql.includes("candidate")) {
			queueMicrotask(() =>
				this.dispatchEvent(
					new MessageEvent("message", {
						data: { id: call.id, error: "SQLITE_IOERR_READ: sqlite3 result code 266: disk I/O error", resultCode: 266 },
					})
				)
			)

			return
		}

		super.postMessage(call)
	}
}

/**
 * A worker whose first open fails with the error {@linkcode FirstOpenFailsWorker.error}
 * names, as the range worker reports a bad first range read.
 */
class FirstOpenFailsWorker extends FakeWorker {
	static error = ""

	override postMessage(call: RangeWorkerCall): void {
		const opens = FakeWorker.posted.filter((posted) => posted.type === "open").length

		if (call.type === "open" && opens === 0) {
			FakeWorker.posted.push(call)

			queueMicrotask(() =>
				this.dispatchEvent(
					new MessageEvent("message", {
						data: { id: call.id, error: FirstOpenFailsWorker.error, resultCode: null },
					})
				)
			)

			return
		}

		super.postMessage(call)
	}
}

afterEach(() => {
	FakeWorker.posted = []
	FakeWorker.created = []
	vi.unstubAllGlobals()
})

describe("a failed statement", () => {
	test("rejects with the worker's SQLite result code, and a failed page read reads as one", async () => {
		vi.stubGlobal("Worker", FailingReadWorker)
		vi.stubGlobal("location", { href: "https://example.test/page" })

		const database = await openRangeDatabase("/candidate.db", "/sqlite/")
		const failure = await database.query("SELECT name FROM candidate").catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(RangeWorkerError)
		expect((failure as RangeWorkerError).resultCode).toBe(266)
		expect(isSQLiteReadFailure(failure)).toBe(true)
		expect(isSQLiteReadFailure(new RangeWorkerError("SQLITE_ERROR: no such table", 1))).toBe(false)
		expect(isSQLiteReadFailure(new Error("SQLITE_IOERR_READ"))).toBe(false)
	})
})

describe("the open request", () => {
	test("openRangeDatabase posts the range strategy with the chunk size", async () => {
		vi.stubGlobal("Worker", FakeWorker)
		vi.stubGlobal("location", { href: "https://example.test/page" })

		await openRangeDatabase("/data.db", "/sqlite/")

		expect(FakeWorker.posted[0]).toMatchObject({
			type: "open",
			strategy: "range",
			chunkSize: DEFAULT_CHUNK_SIZE,
			chunkCacheBytes: DEFAULT_CHUNK_CACHE_BYTES,
		})
	})

	test("openWholeDatabase posts the whole strategy with the absolute database url", async () => {
		vi.stubGlobal("Worker", FakeWorker)
		vi.stubGlobal("location", { href: "https://example.test/page" })

		await openWholeDatabase("/search-index.db.gz", "/mailwoman/sqlite/")

		expect(FakeWorker.posted[0]).toMatchObject({
			type: "open",
			strategy: "whole",
			databaseURL: "https://example.test/search-index.db.gz",
			runtimeModuleURL: "https://example.test/mailwoman/sqlite/index.mjs",
		})

		// The open reads the schema so a corrupt file fails here rather than at the first query.
		expect(FakeWorker.posted[1]).toMatchObject({ type: "query", sql: "SELECT count(*) FROM sqlite_master" })
	})
})

describe("the cache-busting retry", () => {
	const URL_OF = "https://example.test/gazetteer/2026-08-25b/candidate.db"

	test.each([
		"Range 0-65535 of https://example.test/gazetteer/2026-08-25b/candidate.db returned HTTP 200",
		"Range 0-65535 of https://example.test/gazetteer/2026-08-25b/candidate.db returned HTTP 502",
		"Range 0-65535 of https://example.test/gazetteer/2026-08-25b/candidate.db returned 40 bytes, expected 65536",
		"SQLITE_CORRUPT: database disk image is malformed",
	])("reopens with a cb query after %s", async (error) => {
		FirstOpenFailsWorker.error = error
		vi.stubGlobal("Worker", FirstOpenFailsWorker)
		vi.stubGlobal("location", { href: "https://example.test/page" })

		await openRangeDatabase(URL_OF, "/sqlite/")

		const opens = FakeWorker.posted.filter((call) => call.type === "open")

		expect(opens).toHaveLength(2)
		expect(opens[1]).toMatchObject({ databaseURL: expect.stringMatching(/candidate\.db\?cb=\d+$/u) })
	})

	test("does not reopen after a 404", async () => {
		FirstOpenFailsWorker.error = `Range 0-65535 of ${URL_OF} returned HTTP 404`
		vi.stubGlobal("Worker", FirstOpenFailsWorker)
		vi.stubGlobal("location", { href: "https://example.test/page" })

		await expect(openRangeDatabase(URL_OF, "/sqlite/")).rejects.toThrow("returned HTTP 404")
		expect(FakeWorker.posted.filter((call) => call.type === "open")).toHaveLength(1)
	})
})

describe("rangeWorkerMemory", () => {
	test("sums the chunk caches of the open workers and leaves out a closed one", async () => {
		vi.stubGlobal("Worker", FakeWorker)
		vi.stubGlobal("location", { href: "https://example.test/page" })

		// Workers other tests opened and never closed are still live, so the test compares against a baseline.
		const before = await rangeWorkerMemory()
		const kept = await openRangeDatabase("/a.db", "/sqlite/")
		const closed = await openRangeDatabase("/b.db", "/sqlite/")

		closed.close?.()

		const after = await rangeWorkerMemory()

		expect(after.workers - before.workers).toBe(1)
		expect(after.cachedBytes - before.cachedBytes).toBe(4096)

		kept.close?.()
	})
})

describe("a failed worker", () => {
	test("rejects every later call with the worker's error, without posting it", async () => {
		vi.stubGlobal("Worker", FakeWorker)
		vi.stubGlobal("location", { href: "https://example.test/page" })

		const database = await openRangeDatabase("/data.db", "/sqlite/")
		const postedBeforeFailure = FakeWorker.posted.length

		FakeWorker.created.at(-1)!.dispatchEvent(Object.assign(new Event("error"), { message: "worker crashed" }))

		await expect(database.query("SELECT 1")).rejects.toThrow("worker crashed")
		await expect(database.bytesRead()).rejects.toThrow("worker crashed")
		expect(FakeWorker.posted).toHaveLength(postedBeforeFailure)
	})
})
