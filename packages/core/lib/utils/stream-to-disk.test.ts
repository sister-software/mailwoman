/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `streamToDisk` hands each chunk and the response to its callbacks, so a caller can hash the bytes in one pass.
 */

import { afterEach, describe, expect, it, vi } from "vitest"

import { readLocalTextFile } from "#fs/readers"
import { pathExists } from "#fs/readers/stat"
import { temporaryDirectory } from "#fs/temporary"
import { writeLocalTextFile } from "#fs/writers"
import { createHash } from "#hash"
import { ResumeRefusedError, streamToDisk } from "#utils/stream-to-disk"

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
		await expect(readLocalTextFile(destination)).resolves.toBe(body)
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

		await expect(pathExists(destination)).resolves.toBe(false)
		await expect(pathExists(`${destination}.part`)).resolves.toBe(false)
	})

	it("resumes after the partial bytes when the host answers the requested range", async () => {
		const body = CHUNKS.join("")
		const offset = CHUNKS[0]!.length
		let requested: string | null = null

		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			requested = new Headers(init.headers).get("range")

			return new Response(body.slice(offset), {
				status: 206,
				headers: { "content-range": `bytes ${offset}-${body.length - 1}/${body.length}` },
			})
		})

		await using scratch = await temporaryDirectory()
		const destination = scratch.path("resumed.bin")
		const partialPath = scratch.path("resumed.partial").toString()

		await writeLocalTextFile(CHUNKS[0]!, partialPath)

		const bytes = await streamToDisk({
			url: "https://example.test/file",
			destination,
			context: "test",
			partialPath,
			resumeFrom: offset,
		})

		expect(requested).toBe(`bytes=${offset}-`)
		expect(bytes).toBe(body.length)
		await expect(readLocalTextFile(destination)).resolves.toBe(body)
	})

	it("refuses a resume the host answers with the whole object and keeps the partial bytes", async () => {
		vi.stubGlobal("fetch", async () => chunkedResponse())
		await using scratch = await temporaryDirectory()
		const destination = scratch.path("whole.bin")
		const partialPath = scratch.path("whole.partial").toString()

		await writeLocalTextFile("first ", partialPath)

		await expect(
			streamToDisk({ url: "https://example.test/file", destination, context: "test", partialPath, resumeFrom: 6 })
		).rejects.toBeInstanceOf(ResumeRefusedError)

		await expect(readLocalTextFile(partialPath)).resolves.toBe("first ")
		await expect(pathExists(destination)).resolves.toBe(false)
	})
})
