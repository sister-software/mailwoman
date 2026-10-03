/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The client half of the protocol: which `open` request each opener posts. The worker half runs only in
 *   a browser and is covered by the docs Playwright suite.
 */

import { afterEach, describe, expect, test, vi } from "vitest"

import { DEFAULT_CHUNK_SIZE, openRangeDatabase, openWholeDatabase } from "#httpvfs/database"
import type { RangeWorkerCall } from "#httpvfs/worker-protocol"

class FakeWorker extends EventTarget {
	static posted: RangeWorkerCall[] = []

	readonly url: string

	constructor(url: string) {
		super()
		this.url = url
	}

	postMessage(call: RangeWorkerCall): void {
		FakeWorker.posted.push(call)

		const result =
			call.type === "open"
				? { sqliteVersion: "3.53.0" }
				: call.type === "query"
					? [{ n: 1 }]
					: { requests: 1, bytes: 4 }

		queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id: call.id, result } })))
	}

	terminate(): void {}
}

afterEach(() => {
	FakeWorker.posted = []
	vi.unstubAllGlobals()
})

describe("the open request", () => {
	test("openRangeDatabase posts the range strategy with the chunk size", async () => {
		vi.stubGlobal("Worker", FakeWorker)
		vi.stubGlobal("location", { href: "https://example.test/page" })

		await openRangeDatabase("/data.db", "/sqlite/")

		expect(FakeWorker.posted[0]).toMatchObject({ type: "open", strategy: "range", chunkSize: DEFAULT_CHUNK_SIZE })
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
	})
})
