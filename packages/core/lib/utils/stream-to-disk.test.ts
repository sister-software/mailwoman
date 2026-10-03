/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `streamToDisk` hands each chunk and the response to its callbacks, so a caller can hash the bytes in one pass.
 */

import { afterEach, describe, expect, it, vi } from "vitest"

import { pathExists, readLocalTextFile } from "#fs/readers"
import { temporaryDirectory } from "#fs/temporary"
import { createHash } from "#hash"
import { streamToDisk } from "#utils/stream-to-disk"

const CHUNKS = ["first chunk ", "second chunk ", "third chunk"]
const LAST_MODIFIED = "Fri, 02 Oct 2026 22:13:30 GMT"

function chunkedResponse(): Response {
	const encoder = new TextEncoder()

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of CHUNKS) {
				controller.enqueue(encoder.encode(chunk))
			}

			controller.close()
		},
	})

	return new Response(body, { status: 200, headers: { "last-modified": LAST_MODIFIED } })
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("streamToDisk", () => {
	it("passes every chunk and the response to its callbacks while writing the file", async () => {
		vi.stubGlobal("fetch", async () => chunkedResponse())
		await using scratch = await temporaryDirectory()
		const destination = scratch.path("file.bin")
		const hash = createHash("sha256")
		let modified: string | null = null

		const bytes = await streamToDisk({
			url: "https://example.test/file",
			destination,
			context: "test",
			onChunk: (chunk) => hash.update(chunk),
			onResponse: (response) => {
				modified = response.headers.get("last-modified")
			},
		})

		const body = CHUNKS.join("")

		expect(bytes).toBe(body.length)
		expect(await readLocalTextFile(destination)).toBe(body)
		expect(hash.digest("hex")).toBe(createHash("sha256").update(body).digest("hex"))
		expect(modified).toBe(LAST_MODIFIED)
	})

	it("refuses a non-OK response and leaves neither the file nor its partial sibling", async () => {
		vi.stubGlobal("fetch", async () => new Response("absent", { status: 404 }))
		await using scratch = await temporaryDirectory()
		const destination = scratch.path("missing.bin")

		await expect(streamToDisk({ url: "https://example.test/missing", destination, context: "test" })).rejects.toThrow(
			/HTTP 404/u
		)

		expect(await pathExists(destination)).toBe(false)
		expect(await pathExists(`${destination}.part`)).toBe(false)
	})
})
