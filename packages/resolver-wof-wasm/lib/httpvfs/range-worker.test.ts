// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The range worker's first read, run in Node with the worker's globals stubbed.
 *
 *   A page that no service worker controls sends that read to the network directly.
 *   The test's network answers it with a 200 and a streamed body standing in for a multi-gigabyte file.
 */

import { afterAll, beforeAll, expect, test, vi } from "vitest"

import type { RangeWorkerCall, RangeWorkerReply } from "#httpvfs/worker-protocol"

/**
 * A sqlite-wasm entry module the worker imports by URL.
 * The range open fails before it calls the runtime.
 */
const RUNTIME_MODULE_URL = `data:text/javascript,${encodeURIComponent(
	"export default async () => ({ capi: { sqlite3_libversion: () => 'stub' } })"
)}`

const CHUNK_BYTES = 64 * 1024

/**
 * The chunks the whole-file body would send before it ends: 1 GiB in 64 KiB chunks.
 */
const BODY_CHUNKS = 16_384

let listener: ((event: MessageEvent<RangeWorkerCall>) => void) | null = null
const replies: RangeWorkerReply[] = []

beforeAll(async () => {
	vi.stubGlobal("addEventListener", (type: string, handler: (event: MessageEvent<RangeWorkerCall>) => void) => {
		if (type === "message") {
			listener = handler
		}
	})

	vi.stubGlobal("postMessage", (reply: RangeWorkerReply) => replies.push(reply))

	await import("#httpvfs/range-worker")
})

afterAll(() => {
	vi.unstubAllGlobals()
})

test("refuses a whole-file answer to the first range read after reading none of its body", async () => {
	let pulled = 0
	let cancelled = false

	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled++

			if (pulled > BODY_CHUNKS) {
				controller.close()

				return
			}

			controller.enqueue(new Uint8Array(CHUNK_BYTES))
		},
		cancel() {
			cancelled = true
		},
	})

	const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))

	vi.stubGlobal("fetch", fetchMock)

	listener!({
		data: {
			id: 1,
			type: "open",
			strategy: "range",
			databaseURL: "https://example.test/candidate.db",
			runtimeModuleURL: RUNTIME_MODULE_URL,
			chunkSize: CHUNK_BYTES,
			chunkCacheBytes: CHUNK_BYTES * 4,
		},
	} as MessageEvent<RangeWorkerCall>)

	await vi.waitFor(() => expect(replies).toHaveLength(1))

	expect(replies[0]).toMatchObject({ id: 1, error: expect.stringMatching(/returned HTTP 200/) })

	expect(fetchMock).toHaveBeenCalledWith("https://example.test/candidate.db", {
		headers: { Range: `bytes=0-${CHUNK_BYTES - 1}` },
	})

	// The stream fills its queue with one chunk before the status is read.
	// The cancel stops it there.
	expect(cancelled).toBe(true)
	expect(pulled).toBeLessThanOrEqual(1)
})
